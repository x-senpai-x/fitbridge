import { type Answer, checkRange, round } from '../answer';
import { birthYear, recomputeDirty, staleNote, ZONE_CASE } from '../daily';
import { exerciseName } from '../exercise-types';
import { coverage } from './daily-summary';
import { clockFor, localDateTime } from '../time';

// About 3,000 rows read per workout, so 60 days at two workouts a day stays near 400,000 rows.
export const WORKOUT_DAYS = 60;

interface Workout {
  d: string;
  start_ms: number;
  end_ms: number;
  kind: string;
  hr_avg: number | null;
  hr_max: number | null;
  moderate: number | null;
  vigorous: number | null;
  peak: number | null;
}

export async function workouts(env: Env, start: string, end: string): Promise<Answer> {
  checkRange(start, end, WORKOUT_DAYS, 'for workouts', 'split it');
  const stale = await recomputeDirty(env, { start, end });
  const year = birthYear(env);
  const result = await env.DB.prepare(
    `WITH ex AS (
       SELECT local_date AS d, id, start_ms, end_ms, body ->> 'type' AS kind FROM records
       WHERE type = 'exercise' AND local_date BETWEEN ?1 AND ?2 AND deleted = 0 AND source = ?3
     ),
     -- MATERIALIZED: minutes and heart both read it, and without it SQLite scans the heart-rate records twice.
     summaries AS MATERIALIZED (
       SELECT ex.id, m.value ->> '$[0]' AS minute, m.value ->> '$[1]' AS n, m.value ->> '$[2]' AS total,
              m.value ->> '$[4]' AS hi FROM ex
       -- Not the day before: a heart-rate record that started the day before and runs into the workout is assumed rare and is lost.
       JOIN records AS h ON h.type = 'heart_rate' AND h.local_date BETWEEN ex.d AND date(ex.d, '+1 day')
        AND h.start_ms < ex.end_ms + 60000 AND h.end_ms >= ex.start_ms AND h.deleted = 0 AND h.source = ?3
       JOIN json_each(h.minutes) AS m ON m.value ->> '$[0]' >= ex.start_ms AND m.value ->> '$[0]' < ex.end_ms
     ),
     minutes AS (
       SELECT summaries.id, SUM(summaries.total) * 1.0 / SUM(summaries.n) AS bpm, daily.value AS rest,
              220 - (CAST(substr(ex.d, 1, 4) AS INTEGER) - ?4) AS maxhr
       FROM summaries JOIN ex ON ex.id = summaries.id
       JOIN daily ON daily.local_date = ex.d AND daily.metric = 'resting_hr'
       WHERE ?4 IS NOT NULL
       GROUP BY summaries.id, summaries.minute
     ),
     zones AS (
       SELECT id,
              SUM(CASE WHEN zone = 'moderate' THEN 1 ELSE 0 END) AS moderate,
              SUM(CASE WHEN zone = 'vigorous' THEN 1 ELSE 0 END) AS vigorous,
              SUM(CASE WHEN zone = 'peak' THEN 1 ELSE 0 END) AS peak
       FROM (SELECT id, ${ZONE_CASE} AS zone FROM minutes) GROUP BY id
     ),
     heart AS (SELECT id, SUM(total) * 1.0 / SUM(n) AS hr_avg, MAX(hi) AS hr_max FROM summaries GROUP BY id)
     SELECT ex.d, ex.start_ms, ex.end_ms, ex.kind, heart.hr_avg, heart.hr_max, zones.moderate, zones.vigorous, zones.peak
     FROM ex LEFT JOIN heart ON heart.id = ex.id LEFT JOIN zones ON zones.id = ex.id
     ORDER BY ex.start_ms`,
  )
    .bind(start, end, env.PRIMARY_SOURCE, year)
    .all<Workout>();
  const clock = clockFor(env.TIMEZONE);
  const rows = result.results.map((w) => [
    w.d,
    localDateTime(clock, w.start_ms),
    exerciseName(w.kind),
    round((w.end_ms - w.start_ms) / 60_000, 0),
    round(w.hr_avg, 1),
    w.hr_max,
    w.moderate,
    w.vigorous,
    w.peak,
  ]);
  const notes = [
    `Times are local in ${env.TIMEZONE}; a workout belongs to the date it starts.`,
    "Heart-rate figures come from the one-minute heart-rate summaries of the minutes that start inside each workout. Zone minutes count each minute's mean heart rate in Fitbit's published heart-rate-reserve zones (moderate 40 to 59 %, vigorous 60 to 84 %, peak 85 % and up), with that day's resting HR and max HR 220 minus age, the same rule as the daily azm.",
  ];
  if (year === null) notes.push('BIRTH_YEAR is not set, so zone minutes are null.');
  if (stale.length > 0) notes.push(staleNote(stale));
  if (rows.length === 0) notes.unshift('no data for these dates');
  const answer: Answer = {
    workouts: {
      columns: [
        'date',
        'start',
        'type',
        'duration_min',
        'hr_avg',
        'hr_max',
        'moderate_min',
        'vigorous_min',
        'peak_min',
      ],
      rows,
    },
    notes,
  };
  if (rows.length === 0) answer.coverage = await coverage(env, ['exercise_count']);
  return answer;
}
