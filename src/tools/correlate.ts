import { type Answer, type Cell, checkRange, round } from '../answer';
import { recomputeDirty, staleNote } from '../daily';
import { CLOCK_METRICS, type DailyMetric } from '../metrics';
import { pearson, spearman } from '../stats';
import { addDays } from '../time';
import { coverage } from './daily-summary';
import { CLOCK_NOTE, dailySeries } from './series';

export const CORRELATE_DAYS = 366;

export async function correlate(
  env: Env,
  x: DailyMetric,
  y: DailyMetric,
  start: string,
  end: string,
  lag: number,
): Promise<Answer> {
  checkRange(start, end, CORRELATE_DAYS, 'for correlate', 'split it or use get_trends');
  const yEnd = addDays(end, lag);
  const stale = await recomputeDirty(env, { start, end: yEnd });
  const series = await dailySeries(env, start, yEnd, x === y ? [x] : [x, y]);
  const xs = series.get(x) ?? new Map<string, number>();
  const ys = series.get(y) ?? new Map<string, number>();
  const pairs: Cell[][] = [];
  const px: number[] = [];
  const py: number[] = [];
  for (const [date, xv] of xs) {
    if (date > end) continue;
    const yv = ys.get(addDays(date, lag));
    if (yv === undefined) continue;
    pairs.push([date, addDays(date, lag), xv, yv]);
    px.push(xv);
    py.push(yv);
  }
  const notes = [
    `Pairs ${x} on a date with ${y} ${lag === 0 ? 'on the same date' : `${lag} day(s) later`}; dates where either is missing are left out.`,
    'pearson_r measures linear association, spearman_rho rank association; both are null below 3 pairs or when a series is constant. Correlation is not causation.',
  ];
  if (CLOCK_METRICS.has(x) || CLOCK_METRICS.has(y)) notes.push(CLOCK_NOTE);
  if (stale.length > 0) notes.push(staleNote(stale));
  const answer: Answer = {
    n: pairs.length,
    pearson_r: round(pearson(px, py), 3),
    spearman_rho: round(spearman(px, py), 3),
    pairs: { columns: ['date_x', 'date_y', x, y], rows: pairs },
    notes,
  };
  if (pairs.length === 0) {
    const empty = [x, y].filter((m, i, all) => all.indexOf(m) === i && (series.get(m)?.size ?? 0) === 0);
    notes.unshift(
      'no data for these dates',
      ...empty.map((m) => `no data for ${m} in ${start} to ${m === y ? yEnd : end}`),
    );
    answer.coverage = await coverage(env, x === y ? [x] : [x, y]);
  }
  return answer;
}
