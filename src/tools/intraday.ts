import { type Answer, InputError, round } from '../answer';
import type { DailyMetric } from '../metrics';
import { coverage } from './daily-summary';
import { clockFor, localDate, localDateTime, offsetMinutes } from '../time';

export const INTRADAY_METRICS = ['heart_rate', 'steps', 'hrv', 'spo2'] as const;
export type IntradayMetric = (typeof INTRADAY_METRICS)[number];
export const RESOLUTIONS = ['1m', '5m', '15m', '1h'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const MAX_SPAN_HOURS = 48;
export const MAX_BUCKETS = 1000;

const RESOLUTION_MS: Record<Resolution, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };
const RECORD_TYPE: Record<Exclude<IntradayMetric, 'heart_rate'>, string> = {
  steps: 'steps',
  hrv: 'heart_rate_variability',
  spo2: 'oxygen_saturation',
};
const DAILY_METRIC: Record<IntradayMetric, DailyMetric> = {
  heart_rate: 'hr_avg',
  steps: 'steps',
  hrv: 'hrv_rmssd',
  spo2: 'spo2_avg',
};
const UNITS: Record<IntradayMetric, string> = { heart_rate: 'bpm', steps: 'steps per record', hrv: 'ms', spo2: '%' };

export function finestFit(spanMs: number): Resolution {
  return RESOLUTIONS.find((r) => Math.ceil(spanMs / RESOLUTION_MS[r]) <= MAX_BUCKETS) ?? '1h';
}

export async function intraday(
  env: Env,
  metric: IntradayMetric,
  start: string,
  end: string,
  resolution: Resolution,
): Promise<Answer> {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const span = endMs - startMs;
  if (!(span > 0)) throw new InputError(`end ${end} must be after start ${start}`);
  if (span > MAX_SPAN_HOURS * 3_600_000) {
    throw new InputError(
      `range is ${round(span / 3_600_000, 1)} hours; the limit is ${MAX_SPAN_HOURS}, split it or use get_daily_summary`,
    );
  }
  const step = RESOLUTION_MS[resolution];
  const buckets = Math.ceil(span / step);
  if (buckets > MAX_BUCKETS) {
    throw new InputError(
      `${resolution} over this range is ${buckets} buckets; the limit is ${MAX_BUCKETS}, use ${finestFit(span)} or a shorter range`,
    );
  }
  const clock = clockFor(env.TIMEZONE);
  // Buckets align to the local clock, using the zone offset at the start of the range.
  // D1 binds JS numbers as REAL, so the bucket arithmetic casts back to an integer.
  const offset = offsetMinutes(clock, startMs) * 60_000;
  const firstDate = localDate(clock, startMs - 86_400_000);
  const lastDate = localDate(clock, endMs);
  // Heart rate reads the one-minute summaries: a minute counts when it starts inside the range, so a record
  // holding it can start up to a minute after the end.
  const query =
    metric === 'heart_rate'
      ? env.DB.prepare(
          `SELECT CAST(((m.value ->> '$[0]') + ?4) / ?3 AS INTEGER) * ?3 - ?4 AS bucket, MIN(m.value ->> '$[3]') AS lo,
                  SUM(m.value ->> '$[2]') * 1.0 / SUM(m.value ->> '$[1]') AS mean, MAX(m.value ->> '$[4]') AS hi,
                  SUM(m.value ->> '$[1]') AS n
           FROM records AS r JOIN json_each(r.minutes) AS m ON m.value ->> '$[0]' >= ?1 AND m.value ->> '$[0]' < ?2
           WHERE r.type = 'heart_rate' AND r.local_date BETWEEN ?5 AND ?6 AND r.start_ms < ?2 + 60000 AND r.end_ms >= ?1
             AND r.deleted = 0 AND r.source = ?7
           GROUP BY bucket ORDER BY bucket`,
        ).bind(startMs, endMs, step, offset, firstDate, lastDate, env.PRIMARY_SOURCE)
      : env.DB.prepare(
          `SELECT CAST((start_ms + ?4) / ?3 AS INTEGER) * ?3 - ?4 AS bucket, MIN(value) AS lo, AVG(value) AS mean, MAX(value) AS hi, COUNT(*) AS n
           FROM records
           WHERE type = ?8 AND local_date BETWEEN ?5 AND ?6 AND start_ms >= ?1 AND start_ms < ?2 AND deleted = 0 AND source = ?7
           GROUP BY bucket ORDER BY bucket`,
        ).bind(startMs, endMs, step, offset, firstDate, lastDate, env.PRIMARY_SOURCE, RECORD_TYPE[metric]);
  const result = await query.all<{ bucket: number; lo: number; mean: number; hi: number; n: number }>();
  const rows = result.results.map((b) => [
    localDateTime(clock, b.bucket),
    round(b.lo, 1),
    round(b.mean, 1),
    round(b.hi, 1),
    b.n,
  ]);
  const notes = [
    `Bucket starts are local times in ${env.TIMEZONE}, aligned to the local clock; empty buckets are omitted.`,
    `Unit: ${UNITS[metric]}. n is the number of samples in the bucket.`,
    `Only records from ${env.PRIMARY_SOURCE} are used.`,
  ];
  const answer: Answer = { metric, resolution, buckets: { columns: ['bucket_start', 'min', 'avg', 'max', 'n'], rows }, notes };
  if (rows.length === 0) {
    notes.unshift('no data for this range');
    answer.coverage = await coverage(env, [DAILY_METRIC[metric]]);
  }
  return answer;
}
