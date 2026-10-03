import { describe, expect, it } from 'vitest';
import { docId, parseDates, parseId, search } from '../src/search';
import { clockFor } from '../src/time';

const TODAY = '2026-10-03';
const clock = clockFor('Asia/Kolkata');

describe('parseDates', () => {
  it.each([
    ['how did my sleep and HRV trend over the last 30 days?', '2026-09-04', '2026-10-03'],
    ['last 2 weeks', '2026-09-20', '2026-10-03'],
    ['past week', '2026-09-27', '2026-10-03'],
    ['last month', '2026-09-04', '2026-10-03'],
    ['this week', '2026-09-28', '2026-10-03'],
    ['this month', '2026-10-01', '2026-10-03'],
    ['yesterday', '2026-10-02', '2026-10-02'],
    ['last night', '2026-10-03', '2026-10-03'],
    ['September 2026', '2026-09-01', '2026-09-30'],
    ['sleep in Feb', '2026-02-01', '2026-02-28'],
    ['december', '2025-12-01', '2025-12-31'],
    ['2026-08', '2026-08-01', '2026-08-31'],
    ['2026-09-01 to 2026-09-14', '2026-09-01', '2026-09-14'],
    ['2026-09-14 - 2026-09-01', '2026-09-01', '2026-09-14'],
    ['2026-09-05', '2026-09-05', '2026-09-05'],
    ['how am I doing', '2026-09-04', '2026-10-03'],
  ])('%s', (query, start, end) => {
    expect(parseDates(query, TODAY)).toEqual({ start, end });
  });
});

describe('parseDates ignores words that only look like months or dates', () => {
  it.each([
    'is my HRV declining?',
    'did my resting HR decrease?',
    'may I see my sleep',
    'marathon training',
    'sleep 2026-13',
    'steps 2026-02-30',
    'steps 2026-13-01 to 2026-13-05',
  ])('%s falls back to the last 30 days', (query) => {
    expect(parseDates(query, TODAY)).toEqual({ start: '2026-09-04', end: '2026-10-03' });
  });

  it.each([
    ['sleep in May 2026', '2026-05-01', '2026-05-31'],
    ['sleep may 2026', '2026-05-01', '2026-05-31'],
    ['sleep on 12 may', '2026-05-01', '2026-05-31'],
    ['sleep may 12', '2026-05-01', '2026-05-31'],
    ['sleep in sept', '2026-09-01', '2026-09-30'],
    ['august 2026', '2026-08-01', '2026-08-31'],
  ])('%s', (query, start, end) => {
    expect(parseDates(query, TODAY)).toEqual({ start, end });
  });

  it('never throws on odd queries', () => {
    for (const q of ['', '9999-12', '0000-05-01', 'dec 0000', 'jan 99999', '2026-02-30 to 2026-03-05', '\u0000']) {
      expect(() => search(q, TODAY, clock)).not.toThrow();
    }
  });
});

describe('parseId calendar check', () => {
  it.each([
    'daily:2026-02-30:2026-03-05',
    'sleep:2026-13-01:2026-13-02',
    'trends:steps:week:2026-09-01:2026-09-31',
    'intraday:heart_rate:2026-09-23T25:00:00Z:2026-09-24T00:00:00Z',
    'correlate:steps:hrv_rmssd:2026-02-29:2026-03-05:0',
  ])('refuses %s', (id) => {
    expect(() => parseId(id)).toThrow(/not a real calendar date or time/);
  });
});

describe('search', () => {
  it('maps the success-criterion question to sleep and HRV documents', () => {
    expect(search('how did my sleep and HRV trend over the last 30 days?', TODAY, clock).map(docId)).toEqual([
      'sleep:2026-09-04:2026-10-03',
      'trends:sleep_minutes:week:2026-09-04:2026-10-03',
      'trends:hrv_rmssd:week:2026-09-04:2026-10-03',
      'daily:2026-09-04:2026-10-03',
      'overview',
    ]);
  });

  it('offers intraday heart rate for a single day, as local-day instants', () => {
    expect(search('heart rate yesterday', TODAY, clock).map(docId)).toEqual([
      'intraday:heart_rate:2026-10-01T18:30:00Z:2026-10-02T18:30:00Z',
      'trends:resting_hr:week:2026-10-02:2026-10-02',
      'daily:2026-10-02:2026-10-02',
      'overview',
    ]);
  });

  it('switches to monthly trends and drops daily documents over long ranges', () => {
    expect(search('steps over the last 365 days', TODAY, clock).map(docId)).toEqual([
      'trends:steps:month:2025-10-04:2026-10-03',
      'overview',
    ]);
  });

  it('offers the workouts document only within the get_workouts limit', () => {
    expect(search('workouts over the last 60 days', TODAY, clock).map(docId)).toEqual([
      'workouts:2026-08-05:2026-10-03',
      'trends:azm:week:2026-08-05:2026-10-03',
      'overview',
    ]);
    expect(search('workouts over the last 61 days', TODAY, clock).map(docId)).toEqual([
      'trends:azm:week:2026-08-04:2026-10-03',
      'overview',
    ]);
  });

  it('falls back to a daily summary and the overview', () => {
    expect(search('anything new?', TODAY, clock).map(docId)).toEqual(['daily:2026-09-04:2026-10-03', 'overview']);
  });
});

describe('parseId', () => {
  it.each([
    'overview',
    'daily:2026-09-01:2026-09-30',
    'sleep:2026-09-01:2026-09-30',
    'workouts:2026-09-01:2026-09-30',
    'intraday:heart_rate:2026-09-23T05:00:00Z:2026-09-23T06:00:00Z',
    'trends:hrv_rmssd:weekday:2026-06-01:2026-09-30',
    'correlate:steps:sleep_minutes:2026-06-01:2026-09-30:1',
  ])('round-trips %s', (id) => {
    expect(docId(parseId(id))).toBe(id);
  });

  it.each([
    '',
    'daily:2026-09-01',
    'trends:mood:week:2026-09-01:2026-09-30',
    'correlate:steps:hr_avg:2026-09-01:2026-09-30:9',
    'intraday:calories:2026-09-23T05:00:00Z:2026-09-23T06:00:00Z',
  ])('refuses %j and shows the grammar', (id) => {
    expect(() => parseId(id)).toThrow(/ids look like overview, daily:<start>:<end>/);
  });
});
