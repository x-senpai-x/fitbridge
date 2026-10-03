import { describe, expect, it } from 'vitest';
import { addDays, clockFor, localDate, secondsUntilUtcMidnight, utcDay } from '../src/time';

describe('localDate', () => {
  it.each([
    ['Asia/Kolkata', '2026-09-22T18:29:59Z', '2026-09-22'],
    ['Asia/Kolkata', '2026-09-22T18:30:00Z', '2026-09-23'],
    ['Asia/Kolkata', '2026-09-23T05:30:02Z', '2026-09-23'],
    // America/New_York: EST (UTC-5) until 2026-03-08 07:00Z, EDT (UTC-4) until 2026-11-01 06:00Z.
    ['America/New_York', '2026-03-08T04:59:00Z', '2026-03-07'],
    ['America/New_York', '2026-03-08T05:00:00Z', '2026-03-08'],
    ['America/New_York', '2026-11-01T03:59:00Z', '2026-10-31'],
    ['America/New_York', '2026-11-01T04:00:00Z', '2026-11-01'],
    ['America/New_York', '2026-11-02T04:59:00Z', '2026-11-01'],
    ['America/New_York', '2026-11-02T05:00:00Z', '2026-11-02'],
    // Asia/Kathmandu is UTC+5:45: the local date is already the 5th while UTC still reads the 4th, and the month and day are zero padded.
    ['Asia/Kathmandu', '2026-01-04T18:14:59Z', '2026-01-04'],
    ['Asia/Kathmandu', '2026-01-04T18:15:00Z', '2026-01-05'],
  ])('%s %s is %s', (zone, instant, expected) => {
    expect(localDate(clockFor(zone), Date.parse(instant))).toBe(expected);
  });
});

describe('calendar helpers', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('counts seconds to the next 00:00 UTC', () => {
    expect(utcDay(Date.parse('2026-09-23T05:48:12.431Z'))).toBe('2026-09-23');
    expect(secondsUntilUtcMidnight(Date.parse('2026-09-23T05:48:12.431Z'))).toBe(65508);
    expect(secondsUntilUtcMidnight(Date.parse('2026-09-23T23:59:59.500Z'))).toBe(1);
  });
});
