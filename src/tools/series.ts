import { CLOCK_METRICS, type DailyMetric } from '../metrics';
import { clockFor, minutesFromMidnight } from '../time';

// Daily values as numbers; bedtime and wake_time become minutes from local midnight of the wake date.
export async function dailySeries(
  env: Env,
  start: string,
  end: string,
  metrics: readonly DailyMetric[],
): Promise<Map<DailyMetric, Map<string, number>>> {
  const rows = await env.DB.prepare(
    `SELECT local_date, metric, value FROM daily
     WHERE local_date BETWEEN ?1 AND ?2 AND metric IN (SELECT value FROM json_each(?3)) ORDER BY local_date`,
  )
    .bind(start, end, JSON.stringify(metrics))
    .all<{ local_date: string; metric: DailyMetric; value: number }>();
  const clock = clockFor(env.TIMEZONE);
  const series = new Map<DailyMetric, Map<string, number>>(metrics.map((m) => [m, new Map<string, number>()]));
  for (const r of rows.results) {
    const value = CLOCK_METRICS.has(r.metric) ? minutesFromMidnight(clock, r.value, r.local_date) : r.value;
    series.get(r.metric)?.set(r.local_date, value);
  }
  return series;
}

export const CLOCK_NOTE =
  'bedtime and wake_time are minutes from local midnight of the wake date, negative before it (23:30 the evening before is -30).';
