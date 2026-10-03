import { type Answer, type Cell, checkRange, round } from '../answer';
import { birthYear, recomputeDirty, staleNote } from '../daily';
import { CLOCK_METRICS, type DailyMetric, METRIC_INFO, METRIC_NAMES, metricNotes } from '../metrics';
import { clockFor, localClock } from '../time';

export const CELL_BUDGET = 4400;

export async function dailySummary(env: Env, start: string, end: string, metrics?: DailyMetric[]): Promise<Answer> {
  const chosen = metrics ?? [...METRIC_NAMES];
  const limit = Math.floor(CELL_BUDGET / chosen.length);
  checkRange(start, end, limit, `for ${chosen.length} metrics`, 'pick fewer metrics or split it');
  const stale = await recomputeDirty(env, { start, end });
  const rows = await env.DB.prepare(
    `SELECT local_date, metric, value FROM daily
     WHERE local_date BETWEEN ?1 AND ?2 AND metric IN (SELECT value FROM json_each(?3)) ORDER BY local_date`,
  )
    .bind(start, end, JSON.stringify(chosen))
    .all<{ local_date: string; metric: DailyMetric; value: number }>();
  const clock = clockFor(env.TIMEZONE);
  const byDate = new Map<string, Map<DailyMetric, number>>();
  for (const r of rows.results) {
    const day = byDate.get(r.local_date) ?? new Map<DailyMetric, number>();
    day.set(r.metric, r.value);
    byDate.set(r.local_date, day);
  }
  const out: Cell[][] = [...byDate].map(([date, values]) => [
    date,
    ...chosen.map((m) => {
      const v = values.get(m);
      if (v === undefined) return null;
      return CLOCK_METRICS.has(m) ? localClock(clock, v) : round(v, METRIC_INFO[m].digits);
    }),
  ]);
  const notes = metricNotes(chosen, env, birthYear(env) !== null);
  if (stale.length > 0) notes.push(staleNote(stale));
  const answer: Answer = {
    daily: { columns: ['date', ...chosen], rows: out },
    units: Object.fromEntries(chosen.map((m) => [m, METRIC_INFO[m].unit])),
    notes,
  };
  if (out.length === 0) {
    notes.unshift('no data for these dates');
    answer.coverage = await coverage(env, chosen);
  }
  return answer;
}

export async function coverage(
  env: Env,
  metrics: readonly DailyMetric[],
): Promise<{ first_date: string | null; last_date: string | null }> {
  const row = await env.DB.prepare(
    'SELECT MIN(local_date) AS first_date, MAX(local_date) AS last_date FROM daily WHERE metric IN (SELECT value FROM json_each(?1))',
  )
    .bind(JSON.stringify(metrics))
    .first<{ first_date: string | null; last_date: string | null }>();
  return { first_date: row?.first_date ?? null, last_date: row?.last_date ?? null };
}
