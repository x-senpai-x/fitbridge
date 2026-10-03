import { addWrites } from './budget';
import { addDays } from './time';

const DAYS_PER_BATCH = 7;
const MAX_ROUNDS = 2;
export const MAX_RECOMPUTE_QUERIES = 3 * MAX_ROUNDS + 1;
// Counts the days actually recomputed (each dirty date plus the next day), so the hourly cron reads at most
// 24 x 8 full days a day, about 2 million rows.
export const MAX_CRON_DAY_RECOMPUTES = 8;
const STALE_SPANS = 20;

// Shared with the tools so every reader picks the same main sleep and the same zones.
export const MAIN_SLEEP_ORDER = 'end_ms - start_ms DESC, end_ms DESC, id';
export const ZONE_CASE = `CASE
    WHEN bpm - rest >= 0.85 * (maxhr - rest) THEN 'peak'
    WHEN bpm - rest >= 0.60 * (maxhr - rest) THEN 'vigorous'
    WHEN bpm - rest >= 0.40 * (maxhr - rest) THEN 'moderate'
  END`;

// Stage length in minutes for a json_each row aliased s, rounded to whole milliseconds first.
export const STAGE_MINUTES =
  "ROUND((julianday(s.value ->> 'end_time') - julianday(s.value ->> 'start_time')) * 86400000) / 60000.0";

// Which stage kinds a session measured: the daily and per-session sleep figures are null, never 0, without them.
export const stageCounters = (stage: string): string =>
  `COUNT(CASE WHEN ${stage} <> 'unknown' THEN 1 END) AS known,
         COUNT(CASE WHEN ${stage} IN ('light', 'deep', 'rem', 'sleeping') THEN 1 END) AS asleep_staged,
         COUNT(CASE WHEN ${stage} IN ('light', 'deep', 'rem') THEN 1 END) AS granular`;

const TARGETS = 'local_date IN (SELECT value FROM json_each(?1)) AND deleted = 0 AND source = ?2';

const SUMS_SQL = `INSERT INTO daily (local_date, metric, value)
SELECT local_date, type, SUM(value) FROM records
WHERE type IN ('steps', 'distance', 'total_calories') AND ${TARGETS}
GROUP BY local_date, type`;

const NEWEST_SQL = `INSERT INTO daily (local_date, metric, value)
SELECT local_date, CASE type WHEN 'resting_heart_rate' THEN 'resting_hr' WHEN 'vo2_max' THEN 'vo2max' ELSE 'weight' END, value
FROM (
  SELECT local_date, type, value, ROW_NUMBER() OVER (PARTITION BY local_date, type ORDER BY start_ms DESC, id DESC) AS rn
  FROM records WHERE type IN ('resting_heart_rate', 'vo2_max', 'weight') AND ${TARGETS}
)
WHERE rn = 1`;

// D1 allows at most five terms in a compound SELECT, so each statement builds one wide row per date
// and unpivots it through json_each over the metric names, dropping NULLs.
const HEART_SQL = `INSERT INTO daily (local_date, metric, value)
WITH h AS (
  SELECT local_date AS d, SUM(value * n) / SUM(n) AS mean, MIN(vmin) AS lo, MAX(vmax) AS hi
  FROM records WHERE type = 'heart_rate' AND ${TARGETS} GROUP BY local_date
)
SELECT d, m.value, CASE m.value WHEN 'hr_avg' THEN mean WHEN 'hr_min' THEN lo ELSE hi END
FROM h JOIN json_each('["hr_avg", "hr_min", "hr_max"]') AS m`;

const SLEEP_SQL = `INSERT INTO daily (local_date, metric, value)
WITH ranked AS (
  SELECT local_date AS d, start_ms, end_ms, body,
         ROW_NUMBER() OVER (PARTITION BY local_date ORDER BY ${MAIN_SLEEP_ORDER}) AS rn,
         COUNT(*) OVER (PARTITION BY local_date) AS sessions
  FROM records WHERE type = 'sleep' AND ${TARGETS}
),
main AS (SELECT * FROM ranked WHERE rn = 1),
stages AS (
  SELECT main.d, s.value ->> 'stage' AS stage, ${STAGE_MINUTES} AS minutes
  FROM main JOIN json_each(main.body, '$.stages') AS s
),
totals AS (
  SELECT main.d, main.start_ms, main.end_ms, main.sessions, ${stageCounters('stages.stage')},
         (main.end_ms - main.start_ms) / 60000.0 AS in_bed,
         TOTAL(CASE WHEN stages.stage IN ('light', 'deep', 'rem', 'sleeping') THEN stages.minutes END) AS asleep,
         TOTAL(CASE WHEN stages.stage IN ('awake', 'awake_in_bed', 'out_of_bed') THEN stages.minutes END) AS awake,
         TOTAL(CASE WHEN stages.stage = 'light' THEN stages.minutes END) AS light,
         TOTAL(CASE WHEN stages.stage = 'deep' THEN stages.minutes END) AS deep,
         TOTAL(CASE WHEN stages.stage = 'rem' THEN stages.minutes END) AS rem
  FROM main LEFT JOIN stages ON stages.d = main.d
  GROUP BY main.d
)
SELECT d, metric, v FROM (
  SELECT d, m.value AS metric, CASE m.value
    WHEN 'sleep_in_bed_minutes' THEN in_bed
    WHEN 'bedtime' THEN start_ms
    WHEN 'wake_time' THEN end_ms
    WHEN 'naps' THEN sessions - 1
    WHEN 'sleep_minutes' THEN IIF(asleep_staged > 0, asleep, NULL)
    WHEN 'sleep_awake_minutes' THEN IIF(known > 0, awake, NULL)
    WHEN 'sleep_light_minutes' THEN IIF(granular > 0, light, NULL)
    WHEN 'sleep_deep_minutes' THEN IIF(granular > 0, deep, NULL)
    WHEN 'sleep_rem_minutes' THEN IIF(granular > 0, rem, NULL)
    WHEN 'sleep_efficiency' THEN IIF(asleep_staged > 0 AND in_bed > 0, 100.0 * asleep / in_bed, NULL)
  END AS v
  FROM totals JOIN json_each('["sleep_in_bed_minutes", "bedtime", "wake_time", "naps", "sleep_minutes",
    "sleep_awake_minutes", "sleep_light_minutes", "sleep_deep_minutes", "sleep_rem_minutes", "sleep_efficiency"]') AS m
)
WHERE v IS NOT NULL`;

const NIGHT_SQL = `INSERT INTO daily (local_date, metric, value)
WITH main AS (
  SELECT d, start_ms, end_ms FROM (
    SELECT local_date AS d, start_ms, end_ms, ROW_NUMBER() OVER (PARTITION BY local_date ORDER BY ${MAIN_SLEEP_ORDER}) AS rn
    FROM records WHERE type = 'sleep' AND ${TARGETS}
  ) WHERE rn = 1
),
night AS (
  SELECT main.d, r.type, r.value FROM main
  JOIN records AS r ON r.type IN ('heart_rate_variability', 'respiratory_rate', 'oxygen_saturation')
   AND r.local_date BETWEEN date(main.d, '-1 day') AND main.d
   AND r.start_ms BETWEEN main.start_ms AND main.end_ms AND r.deleted = 0 AND r.source = ?2
  UNION ALL
  SELECT main.d, r.type, s.value ->> '$[1]' FROM main
  JOIN records AS r ON r.type = 'skin_temperature'
   AND r.local_date BETWEEN date(main.d, '-1 day') AND main.d
   AND r.start_ms <= main.end_ms AND r.end_ms >= main.start_ms AND r.deleted = 0 AND r.source = ?2
  JOIN json_each(r.body) AS s ON s.value ->> '$[0]' BETWEEN main.start_ms AND main.end_ms
),
wide AS (
  SELECT d,
         AVG(CASE WHEN type = 'heart_rate_variability' THEN value END) AS hrv,
         AVG(CASE WHEN type = 'respiratory_rate' THEN value END) AS resp,
         AVG(CASE WHEN type = 'skin_temperature' THEN value END) AS skin,
         AVG(CASE WHEN type = 'oxygen_saturation' THEN value END) AS spo2,
         MIN(CASE WHEN type = 'oxygen_saturation' THEN value END) AS spo2_low
  FROM night GROUP BY d
)
SELECT d, metric, v FROM (
  SELECT d, m.value AS metric, CASE m.value
    WHEN 'hrv_rmssd' THEN hrv WHEN 'respiratory_rate' THEN resp WHEN 'skin_temp_delta' THEN skin
    WHEN 'spo2_avg' THEN spo2 ELSE spo2_low END AS v
  FROM wide JOIN json_each('["hrv_rmssd", "respiratory_rate", "skin_temp_delta", "spo2_avg", "spo2_min"]') AS m
)
WHERE v IS NOT NULL`;

const EXERCISE_SQL = `INSERT INTO daily (local_date, metric, value)
WITH e AS (
  SELECT local_date AS d, COUNT(*) AS sessions, SUM(end_ms - start_ms) / 60000.0 AS minutes
  FROM records WHERE type = 'exercise' AND ${TARGETS} GROUP BY local_date
)
SELECT d, m.value, CASE m.value WHEN 'exercise_count' THEN sessions ELSE minutes END
FROM e JOIN json_each('["exercise_count", "exercise_minutes"]') AS m`;

const AZM_SQL = `INSERT INTO daily (local_date, metric, value)
WITH zones AS (
  SELECT local_date AS d, value AS rest, 220 - (CAST(substr(local_date, 1, 4) AS INTEGER) - ?3) AS maxhr
  FROM daily WHERE metric = 'resting_hr' AND local_date IN (SELECT value FROM json_each(?1))
),
-- CROSS JOIN keeps the one-row-per-day zones as the outer loop; otherwise SQLite probes daily once per record.
minutes AS (
  SELECT zones.d, zones.rest, zones.maxhr, SUM(m.value ->> '$[2]') * 1.0 / SUM(m.value ->> '$[1]') AS bpm
  FROM zones
  CROSS JOIN records AS r ON r.type = 'heart_rate' AND r.local_date = zones.d AND r.deleted = 0 AND r.source = ?2
  JOIN json_each(r.minutes) AS m
  GROUP BY zones.d, m.value ->> '$[0]'
),
zoned AS (SELECT d, ${ZONE_CASE} AS zone FROM minutes),
wide AS (
  SELECT d,
         SUM(CASE zone WHEN 'moderate' THEN 1 WHEN 'vigorous' THEN 2 WHEN 'peak' THEN 2 ELSE 0 END) AS azm,
         SUM(CASE WHEN zone = 'moderate' THEN 1 ELSE 0 END) AS moderate,
         SUM(CASE WHEN zone = 'vigorous' THEN 1 ELSE 0 END) AS vigorous,
         SUM(CASE WHEN zone = 'peak' THEN 1 ELSE 0 END) AS peak
  FROM zoned GROUP BY d
)
SELECT d, m.value, CASE m.value WHEN 'azm' THEN azm WHEN 'zone_moderate_minutes' THEN moderate
  WHEN 'zone_vigorous_minutes' THEN vigorous ELSE peak END
FROM wide JOIN json_each('["azm", "zone_moderate_minutes", "zone_vigorous_minutes", "zone_peak_minutes"]') AS m`;

export function birthYear(env: Env): number | null {
  const year = Number(env.BIRTH_YEAR);
  return env.BIRTH_YEAR.trim() !== '' && Number.isInteger(year) && year > 1900 ? year : null;
}

export async function recomputeDays(env: Env, dirty: string[]): Promise<void> {
  // A sample on date D can change the night metrics of D + 1, whose main sleep may start on D.
  const targets = JSON.stringify([...new Set(dirty.flatMap((d) => [d, addDays(d, 1)]))]);
  const source = env.PRIMARY_SOURCE;
  const statements = [
    env.DB.prepare('DELETE FROM dirty_days WHERE local_date IN (SELECT value FROM json_each(?1))').bind(
      JSON.stringify(dirty),
    ),
    env.DB.prepare('DELETE FROM daily WHERE local_date IN (SELECT value FROM json_each(?1))').bind(targets),
    env.DB.prepare(SUMS_SQL).bind(targets, source),
    env.DB.prepare(NEWEST_SQL).bind(targets, source),
    env.DB.prepare(HEART_SQL).bind(targets, source),
    env.DB.prepare(SLEEP_SQL).bind(targets, source),
    env.DB.prepare(NIGHT_SQL).bind(targets, source),
    env.DB.prepare(EXERCISE_SQL).bind(targets, source),
  ];
  const year = birthYear(env);
  if (year !== null) statements.push(env.DB.prepare(AZM_SQL).bind(targets, source, year));
  await addWrites(env.DB, Date.now(), await env.DB.batch(statements));
}

// One cron run: the newest dirty days whose recomputed days (each date and the next) fit MAX_CRON_DAY_RECOMPUTES.
export async function recomputeScheduled(env: Env): Promise<void> {
  const { results } = await env.DB.prepare('SELECT local_date FROM dirty_days ORDER BY local_date DESC LIMIT ?1')
    .bind(MAX_CRON_DAY_RECOMPUTES)
    .all<{ local_date: string }>();
  const recomputed = new Set<string>();
  const picked: string[] = [];
  for (const { local_date } of results) {
    const days = new Set([...recomputed, local_date, addDays(local_date, 1)]);
    if (days.size > MAX_CRON_DAY_RECOMPUTES) continue;
    for (const day of days) recomputed.add(day);
    picked.push(local_date);
  }
  if (picked.length > 0) await recomputeDays(env, picked);
}

// Recomputes the newest dirty days first, at most MAX_ROUNDS batches, and returns the dirty days still left
// in the range and the day before it, newest first, so a tool can name them.
export async function recomputeDirty(env: Env, range?: { start: string; end: string }): Promise<string[]> {
  for (let round = 0; ; round++) {
    // SQLite reads LIMIT -1 as no limit, so the last read lists every day left.
    const limit = round === MAX_ROUNDS ? -1 : DAYS_PER_BATCH;
    const query =
      range === undefined
        ? env.DB.prepare('SELECT local_date FROM dirty_days ORDER BY local_date DESC LIMIT ?1').bind(limit)
        : env.DB.prepare(
            'SELECT local_date FROM dirty_days WHERE local_date BETWEEN ?1 AND ?2 ORDER BY local_date DESC LIMIT ?3',
          ).bind(addDays(range.start, -1), range.end, limit);
    const dirty = (await query.all<{ local_date: string }>()).results.map((r) => r.local_date);
    if (dirty.length === 0 || round === MAX_ROUNDS) return dirty;
    await recomputeDays(env, dirty);
  }
}

// Consecutive dates collapse into one span and at most STALE_SPANS spans are named, so a backlog stays a short note.
export function staleNote(dates: string[]): string {
  const sorted = [...dates].sort();
  const spans: [string, string][] = [];
  for (const date of sorted) {
    const span = spans.at(-1);
    if (span !== undefined && date === addDays(span[1], 1)) span[1] = date;
    else spans.push([date, date]);
  }
  const shown = spans.slice(0, STALE_SPANS);
  const named = shown.map(([first, last]) => (first === last ? first : `${first} to ${last}`)).join(', ');
  const lastNamed = shown.at(-1)?.[1] ?? '';
  const later = sorted.filter((date) => date > lastNamed);
  const rest = later.length > 0 ? `, and ${later.length} later dates through ${later.at(-1)}` : '';
  return `Still being recomputed, so these dates may change: ${named}${rest}. Ask again in a few minutes for final numbers.`;
}
