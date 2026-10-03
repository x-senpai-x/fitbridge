import { type Answer, type Cell, checkRange, daysBetween, InputError, round } from '../answer';
import { recomputeDirty, staleNote } from '../daily';
import { CLOCK_METRICS, type DailyMetric, METRIC_INFO } from '../metrics';
import { mean, median, sampleSd, slope } from '../stats';
import { addDays, weekday } from '../time';
import { coverage } from './daily-summary';
import { CLOCK_NOTE, dailySeries } from './series';

export const GROUPS = ['week', 'month', 'weekday'] as const;
export type Group = (typeof GROUPS)[number];
export const TREND_DAYS = 1096;
export const TREND_ROWS = 300;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function groupOf(date: string, group: Group): string {
  if (group === 'month') return date.slice(0, 7);
  if (group === 'weekday') return WEEKDAYS[weekday(date)] ?? '';
  return addDays(date, -weekday(date));
}

function groupCount(start: string, end: string, group: Group): number {
  if (group === 'weekday') return 7;
  const labels = new Set<string>();
  for (let d = start; d <= end; d = addDays(d, 1)) labels.add(groupOf(d, group));
  return labels.size;
}

export async function trends(
  env: Env,
  metrics: DailyMetric[],
  start: string,
  end: string,
  group: Group,
): Promise<Answer> {
  checkRange(start, end, TREND_DAYS, 'for get_trends', 'split it');
  const rowsNeeded = groupCount(start, end, group) * metrics.length;
  if (rowsNeeded > TREND_ROWS) {
    throw new InputError(`${rowsNeeded} group rows; the limit is ${TREND_ROWS}, pick fewer metrics or group by month`);
  }
  const stale = await recomputeDirty(env, { start, end });
  const series = await dailySeries(env, start, end, metrics);
  const groupRows: Cell[][] = [];
  const slopeRows: Cell[][] = [];
  for (const metric of metrics) {
    const values = series.get(metric) ?? new Map<string, number>();
    const digits = CLOCK_METRICS.has(metric) ? 0 : METRIC_INFO[metric].digits + 1;
    const groups = new Map<string, number[]>();
    for (const [date, value] of values) {
      const label = groupOf(date, group);
      groups.set(label, [...(groups.get(label) ?? []), value]);
    }
    const labels = group === 'weekday' ? WEEKDAYS.filter((w) => groups.has(w)) : [...groups.keys()].sort();
    for (const label of labels) {
      const xs = groups.get(label) ?? [];
      groupRows.push([
        metric,
        label,
        xs.length,
        round(mean(xs), digits),
        round(median(xs), digits),
        round(sampleSd(xs), digits),
        round(Math.min(...xs), digits),
        round(Math.max(...xs), digits),
      ]);
    }
    const dates = [...values.keys()];
    const perDay = slope(
      dates.map((d) => daysBetween(start, d) - 1),
      [...values.values()],
    );
    slopeRows.push([
      metric,
      perDay === null ? null : round(perDay * 7, digits + 1),
      dates.length,
      dates[0] ?? null,
      dates.at(-1) ?? null,
    ]);
  }
  const notes = [
    `Statistics are exact, computed on the server over daily values; days with no data are left out, not counted as 0. week groups are labelled by their Monday.`,
    'sd is the sample standard deviation; slope_per_week is the least-squares slope over the whole range, times 7.',
    `Units: ${metrics.map((m) => `${m} ${CLOCK_METRICS.has(m) ? 'min' : METRIC_INFO[m].unit}`).join(', ')}.`,
  ];
  if (metrics.some((m) => CLOCK_METRICS.has(m))) notes.push(CLOCK_NOTE);
  if (stale.length > 0) notes.push(staleNote(stale));
  const answer: Answer = {
    groups: { columns: ['metric', group, 'n', 'mean', 'median', 'sd', 'min', 'max'], rows: groupRows },
    trend: { columns: ['metric', 'slope_per_week', 'n', 'first_date', 'last_date'], rows: slopeRows },
    notes,
  };
  if (groupRows.length === 0) {
    notes.unshift('no data for these dates');
    answer.coverage = await coverage(env, metrics);
  }
  return answer;
}
