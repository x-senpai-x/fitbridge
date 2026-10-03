export interface Clock {
  days: Intl.DateTimeFormat;
  minutes: Intl.DateTimeFormat;
  dayCache: Map<number, string>;
}

const DAY_MS = 86_400_000;

// Building a formatter costs about 30 µs, so one Clock serves a whole request.
export function clockFor(zone: string): Clock {
  return {
    days: new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }),
    minutes: new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }),
    dayCache: new Map(),
  };
}

// Every zone offset in use is a multiple of 15 minutes, so a quarter hour has one local date.
export function localDate(clock: Clock, ms: number): string {
  const quarter = Math.floor(ms / 900_000);
  let date = clock.dayCache.get(quarter);
  if (date === undefined) {
    let year = '';
    let month = '';
    let day = '';
    for (const part of clock.days.formatToParts(ms)) {
      if (part.type === 'year') year = part.value;
      else if (part.type === 'month') month = part.value;
      else if (part.type === 'day') day = part.value;
    }
    date = `${year}-${month}-${day}`;
    clock.dayCache.set(quarter, date);
  }
  return date;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function secondsUntilUtcMidnight(ms: number): number {
  const next = Date.parse(`${addDays(utcDay(ms), 1)}T00:00:00Z`);
  return Math.ceil((next - ms) / 1000);
}

export function localDateTime(clock: Clock, ms: number): string {
  return clock.minutes.format(ms).replace(', ', ' ');
}

export function localClock(clock: Clock, ms: number): string {
  return localDateTime(clock, ms).slice(11);
}

// Minutes the zone is ahead of UTC at this instant.
export function offsetMinutes(clock: Clock, ms: number): number {
  const t = localDateTime(clock, ms);
  const wall = Date.UTC(
    Number(t.slice(0, 4)),
    Number(t.slice(5, 7)) - 1,
    Number(t.slice(8, 10)),
    Number(t.slice(11, 13)),
    Number(t.slice(14, 16)),
  );
  return Math.round((wall - (ms - (ms % 60_000))) / 60_000);
}

// Minutes from local midnight of `date` to the instant, negative before it: 23:30 the evening before is -30.
export function minutesFromMidnight(clock: Clock, ms: number, date: string): number {
  const t = localDateTime(clock, ms);
  const days = Math.round((Date.parse(`${t.slice(0, 10)}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY_MS);
  return days * 1440 + Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16));
}

export function weekday(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

// The UTC instant at which `date` begins in the clock's zone.
export function startOfLocalDay(clock: Clock, date: string): number {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  const guess = utcMidnight - offsetMinutes(clock, utcMidnight) * 60_000;
  return utcMidnight - offsetMinutes(clock, guess) * 60_000;
}
