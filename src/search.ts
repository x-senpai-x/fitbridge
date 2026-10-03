import { z } from 'zod';
import { daysBetween, InputError } from './answer';
import { type DailyMetric, METRIC_NAMES } from './metrics';
import { CELL_BUDGET } from './tools/daily-summary';
import { INTRADAY_METRICS, type IntradayMetric } from './tools/intraday';
import { SUMMARY_DAYS } from './tools/sleep';
import { GROUPS, type Group } from './tools/trends';
import { WORKOUT_DAYS } from './tools/workouts';
import { addDays, type Clock, startOfLocalDay, weekday } from './time';

export type Doc =
  | { kind: 'overview' }
  | { kind: 'daily' | 'sleep' | 'workouts'; start: string; end: string }
  | { kind: 'intraday'; metric: IntradayMetric; start: string; end: string }
  | { kind: 'trends'; metric: DailyMetric; group: Group; start: string; end: string }
  | { kind: 'correlate'; x: DailyMetric; y: DailyMetric; start: string; end: string; lag: number };

export const ID_GRAMMAR = [
  'overview',
  'daily:<start>:<end>',
  'sleep:<start>:<end>',
  'workouts:<start>:<end>',
  'intraday:<heart_rate|steps|hrv|spo2>:<start instant>:<end instant>',
  'trends:<metric>:<week|month|weekday>:<start>:<end>',
  'correlate:<metric x>:<metric y>:<start>:<end>:<lag days 0-7>',
  'Dates are local YYYY-MM-DD, inclusive; instants are ISO 8601 UTC such as 2026-09-23T05:30:00Z.',
];

const D = '(\\d{4}-\\d{2}-\\d{2})';
const I = '(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?Z)';
const W = '([a-z0-9_]+)';

const calendarDate = z.iso.date();
const calendarInstant = z.iso.datetime({ offset: true });
const isDate = (d: string): boolean => calendarDate.safeParse(d).success;

const isMetric = (m: string): m is DailyMetric => (METRIC_NAMES as readonly string[]).includes(m);
const isIntraday = (m: string): m is IntradayMetric => (INTRADAY_METRICS as readonly string[]).includes(m);
const isGroup = (g: string): g is Group => (GROUPS as readonly string[]).includes(g);

export function parseId(id: string): Doc {
  const doc = matchId(id);
  for (const d of id.match(/\d{4}-\d{2}-\d{2}(?:T[0-9:.]+Z)?/g) ?? []) {
    const valid = d.length === 10 ? isDate(d) : calendarInstant.safeParse(d).success;
    if (!valid) throw new InputError(`"${d}" in document id "${id}" is not a real calendar date or time`);
  }
  return doc;
}

function matchId(id: string): Doc {
  if (id === 'overview') return { kind: 'overview' };
  const [, kind = '', a = '', b = ''] = new RegExp(`^(daily|sleep|workouts):${D}:${D}$`).exec(id) ?? [];
  if (kind === 'daily' || kind === 'sleep' || kind === 'workouts') return { kind, start: a, end: b };
  const [, im = '', is = '', ie = ''] = new RegExp(`^intraday:${W}:${I}:${I}$`).exec(id) ?? [];
  if (isIntraday(im)) return { kind: 'intraday', metric: im, start: is, end: ie };
  const [, tm = '', tg = '', ts = '', te = ''] = new RegExp(`^trends:${W}:${W}:${D}:${D}$`).exec(id) ?? [];
  if (isMetric(tm) && isGroup(tg)) return { kind: 'trends', metric: tm, group: tg, start: ts, end: te };
  const [, cx = '', cy = '', cs = '', ce = '', lag = ''] =
    new RegExp(`^correlate:${W}:${W}:${D}:${D}:([0-7])$`).exec(id) ?? [];
  if (isMetric(cx) && isMetric(cy)) return { kind: 'correlate', x: cx, y: cy, start: cs, end: ce, lag: Number(lag) };
  throw new InputError(`unknown document id "${id}"; ids look like ${ID_GRAMMAR.slice(0, 7).join(', ')}`);
}

export function docId(doc: Doc): string {
  switch (doc.kind) {
    case 'overview':
      return 'overview';
    case 'daily':
    case 'sleep':
    case 'workouts':
      return `${doc.kind}:${doc.start}:${doc.end}`;
    case 'intraday':
      return `intraday:${doc.metric}:${doc.start}:${doc.end}`;
    case 'trends':
      return `trends:${doc.metric}:${doc.group}:${doc.start}:${doc.end}`;
    case 'correlate':
      return `correlate:${doc.x}:${doc.y}:${doc.start}:${doc.end}:${doc.lag}`;
  }
}

export function docTitle(doc: Doc): string {
  switch (doc.kind) {
    case 'overview':
      return 'Overview of the stored health data';
    case 'daily':
      return `Daily summary ${doc.start} to ${doc.end}`;
    case 'sleep':
      return `Sleep sessions ${doc.start} to ${doc.end}`;
    case 'workouts':
      return `Workouts ${doc.start} to ${doc.end}`;
    case 'intraday':
      return `Intraday ${doc.metric} ${doc.start} to ${doc.end}`;
    case 'trends':
      return `${doc.metric} by ${doc.group}, ${doc.start} to ${doc.end}`;
    case 'correlate':
      return `Correlation of ${doc.x} with ${doc.y} (lag ${doc.lag} days), ${doc.start} to ${doc.end}`;
  }
}

const MONTH_NAMES = [
  'january|jan',
  'february|feb',
  'march|mar',
  'april|apr',
  'may',
  'june|jun',
  'july|jul',
  'august|aug',
  'september|sept|sep',
  'october|oct',
  'november|nov',
  'december|dec',
];
const MONTH_WORD = new RegExp(`\\b(${MONTH_NAMES.join('|')})\\b\\.?(?:\\s+(\\d{4}))?`, 'g');
const DAY_NUMBER = '\\d{1,2}(?:st|nd|rd|th)?';
const YEARS = { min: 1900, max: 2200 };
const sensibleYear = (year: number): boolean => year >= YEARS.min && year <= YEARS.max;

// "may" is also a verb, so it counts as a month only beside a year or a day number.
function namedMonth(q: string): { month: number; year: number | undefined } | undefined {
  for (const match of q.matchAll(MONTH_WORD)) {
    const [, word = '', year] = match;
    const before = new RegExp(`\\b${DAY_NUMBER}\\s+$`).test(q.slice(0, match.index));
    const after = new RegExp(`^\\s*${DAY_NUMBER}\\b`).test(q.slice(match.index + word.length));
    if (word === 'may' && year === undefined && !before && !after) continue;
    if (year !== undefined && !sensibleYear(Number(year))) continue;
    const month = MONTH_NAMES.findIndex((names) => names.split('|').includes(word));
    return { month, year: year === undefined ? undefined : Number(year) };
  }
  return undefined;
}

function monthRange(year: number, month: number): { start: string; end: string } {
  const start = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return {
    start,
    end: addDays(month === 11 ? `${year + 1}-01-01` : `${year}-${String(month + 2).padStart(2, '0')}-01`, -1),
  };
}

export function parseDates(query: string, today: string): { start: string; end: string } {
  const q = query.toLowerCase();
  const span = /(\d{4}-\d{2}-\d{2})\s*(?:to|through|until|–|-)\s*(\d{4}-\d{2}-\d{2})/.exec(q);
  if (span?.[1] !== undefined && span[2] !== undefined && isDate(span[1]) && isDate(span[2])) {
    return span[1] <= span[2] ? { start: span[1], end: span[2] } : { start: span[2], end: span[1] };
  }
  const day = /\b(\d{4}-\d{2}-\d{2})\b/.exec(q)?.[1];
  if (day !== undefined && isDate(day)) return { start: day, end: day };
  const ym = /\b(\d{4})-(\d{2})\b(?!-)/.exec(q);
  const ymMonth = Number(ym?.[2]);
  if (ym?.[1] !== undefined && ymMonth >= 1 && ymMonth <= 12 && sensibleYear(Number(ym[1]))) {
    return monthRange(Number(ym[1]), ymMonth - 1);
  }
  const last = /\b(?:last|past)\s+(\d+)\s+(day|week|month)s?\b/.exec(q);
  if (last?.[1] !== undefined && last[2] !== undefined) {
    const days = Number(last[1]) * (last[2] === 'day' ? 1 : last[2] === 'week' ? 7 : 30);
    return { start: addDays(today, -(days - 1)), end: today };
  }
  if (/\b(?:last|past) week\b/.test(q)) return { start: addDays(today, -6), end: today };
  if (/\b(?:last|past) month\b/.test(q)) return { start: addDays(today, -29), end: today };
  if (/\bthis week\b/.test(q)) return { start: addDays(today, -weekday(today)), end: today };
  if (/\bthis month\b/.test(q)) return { start: `${today.slice(0, 7)}-01`, end: today };
  if (/\byesterday\b/.test(q)) return { start: addDays(today, -1), end: addDays(today, -1) };
  if (/\btoday\b|\blast night\b/.test(q)) return { start: today, end: today };
  const named = namedMonth(q);
  if (named !== undefined) {
    const thisYear = Number(today.slice(0, 4));
    const year = named.year ?? (named.month + 1 <= Number(today.slice(5, 7)) ? thisYear : thisYear - 1);
    return monthRange(year, named.month);
  }
  return { start: addDays(today, -29), end: today };
}

const TOPICS: [RegExp, DailyMetric | 'sleep' | 'workouts' | 'heart'][] = [
  [/\bsleep|slept|\bnaps?\b|\brem\b|bedtime/, 'sleep'],
  [/\bhrv\b|heart rate variability|rmssd/, 'hrv_rmssd'],
  [/heart rate|\bhr\b|pulse|resting/, 'heart'],
  [/\bsteps?\b|walk|distance|active|calorie/, 'steps'],
  [/workout|exercise|\brun|\bride|training|\bzones?\b|\bazm\b/, 'workouts'],
  [/\btemp/, 'skin_temp_delta'],
  [/spo2|oxygen|saturation/, 'spo2_avg'],
];

export function search(query: string, today: string, clock: Clock): Doc[] {
  const { start, end } = parseDates(query, today);
  const q = query.toLowerCase();
  const days = daysBetween(start, end);
  const group: Group = days > 180 ? 'month' : 'week';
  const docs: Doc[] = [];
  const add = (doc: Doc) => {
    if (!docs.some((d) => docId(d) === docId(doc))) docs.push(doc);
  };
  const daily = () => {
    if (days <= Math.floor(CELL_BUDGET / METRIC_NAMES.length)) add({ kind: 'daily', start, end });
  };
  for (const [pattern, topic] of TOPICS) {
    if (!pattern.test(q)) continue;
    if (topic === 'sleep') {
      if (days <= SUMMARY_DAYS) add({ kind: 'sleep', start, end });
      add({ kind: 'trends', metric: 'sleep_minutes', group, start, end });
    } else if (topic === 'workouts') {
      if (days <= WORKOUT_DAYS) add({ kind: 'workouts', start, end });
      add({ kind: 'trends', metric: 'azm', group, start, end });
    } else if (topic === 'heart') {
      if (days <= 2) {
        add({
          kind: 'intraday',
          metric: 'heart_rate',
          start: isoZ(startOfLocalDay(clock, start)),
          end: isoZ(startOfLocalDay(clock, addDays(end, 1))),
        });
      }
      add({ kind: 'trends', metric: 'resting_hr', group, start, end });
      daily();
    } else {
      add({ kind: 'trends', metric: topic, group, start, end });
      daily();
    }
  }
  if (docs.length === 0) daily();
  add({ kind: 'overview' });
  return docs.slice(0, 10);
}

function isoZ(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}
