// SYNTHETIC test data: generated, not measured. Density follows what the exporter observed for Fitbit
// (about 245,000 heart-rate samples, 10,900 one-minute calorie records and 470 HRV samples a week).
// Times are laid out in Asia/Kolkata (UTC+05:30), the default TIMEZONE.

const FITBIT = 'com.fitbit.FitbitMobile';
const MINUTE = 60_000;
const SAMPLES_PER_MINUTE = 24;
const STAGE_CYCLE: [string, number][] = [
  ['light', 30],
  ['deep', 20],
  ['light', 10],
  ['rem', 20],
  ['awake', 5],
];

type Value = string | number;
type Item = Record<string, Value | Record<string, Value>[]>;
export interface SyntheticPayload {
  timestamp: string;
  app_version: string;
  source: string;
  sequence: number;
  [type: string]: string | number | Item[];
}

export interface SyntheticDay {
  date: string;
  expected: Record<string, number>;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const midnight = (date: string): number => Date.parse(`${date}T00:00:00+05:30`);
const round2 = (x: number): number => Math.round(x * 100) / 100;

function addDaysIso(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// One day of data whose wake date is `date`: the night before it, then the day.
export function syntheticDay(
  date: string,
  birthYear: number,
): { items: [string, Item][]; expected: Record<string, number> } {
  const random = mulberry32(Date.parse(date) / 86_400_000);
  const day0 = midnight(date);
  const sleepStart = day0 - 60 * MINUTE;
  const sleepEnd = day0 + 390 * MINUTE;
  const exerciseStart = day0 + 18 * 60 * MINUTE;
  const exerciseEnd = exerciseStart + 30 * MINUTE;
  const items: [string, Item][] = [];
  const e: Record<string, number> = {};

  const stages: Record<string, Value>[] = [];
  const stageMinutes: Record<string, number> = { light: 0, deep: 0, rem: 0, awake: 0 };
  let t = sleepStart;
  for (let i = 0; t < sleepEnd; i++) {
    const [stage, minutes] = STAGE_CYCLE[i % STAGE_CYCLE.length] ?? ['light', 30];
    const end = Math.min(t + minutes * MINUTE, sleepEnd);
    stages.push({ stage, start_time: iso(t), end_time: iso(end), duration_seconds: (end - t) / 1000 });
    stageMinutes[stage] = (stageMinutes[stage] ?? 0) + (end - t) / MINUTE;
    t = end;
  }
  items.push([
    'sleep',
    {
      session_end_time: iso(sleepEnd),
      duration_seconds: (sleepEnd - sleepStart) / 1000,
      stages,
      uuid: `sleep-${date}`,
      source: FITBIT,
    },
  ]);
  const asleep = (stageMinutes.light ?? 0) + (stageMinutes.deep ?? 0) + (stageMinutes.rem ?? 0);
  Object.assign(e, {
    sleep_in_bed_minutes: 450,
    sleep_minutes: asleep,
    sleep_awake_minutes: stageMinutes.awake ?? 0,
    sleep_light_minutes: stageMinutes.light ?? 0,
    sleep_deep_minutes: stageMinutes.deep ?? 0,
    sleep_rem_minutes: stageMinutes.rem ?? 0,
    sleep_efficiency: (100 * asleep) / 450,
    bedtime: sleepStart,
    wake_time: sleepEnd,
    naps: 0,
  });

  const rest = 55 + Math.floor(random() * 6);
  items.push(['resting_heart_rate', { bpm: rest, time: `${date}T00:00:00Z`, uuid: `rhr-${date}`, source: FITBIT }]);
  e.resting_hr = rest;

  const maxhr = 220 - (Number(date.slice(0, 4)) - birthYear);
  let hrSum = 0;
  let hrCount = 0;
  let hrMin = Infinity;
  let hrMax = -Infinity;
  const zones = { moderate: 0, vigorous: 0, peak: 0 };
  for (let m = 0; m < 1440; m++) {
    const start = day0 + m * MINUTE;
    const inSleep = start >= sleepStart && start < sleepEnd;
    const inExercise = start >= exerciseStart && start < exerciseEnd;
    const base = inExercise ? 110 + ((start - exerciseStart) / MINUTE) * 2.2 : inSleep ? 54 : 72;
    let minuteSum = 0;
    for (let k = 0; k < SAMPLES_PER_MINUTE; k++) {
      const ms = start + k * 2500;
      const bpm = Math.round(base + random() * 10);
      items.push(['heart_rate', { bpm, time: iso(ms), uuid: `hr-${date}-${m}#${ms}`, source: FITBIT }]);
      minuteSum += bpm;
      hrSum += bpm;
      hrCount += 1;
      hrMin = Math.min(hrMin, bpm);
      hrMax = Math.max(hrMax, bpm);
    }
    const mean = minuteSum / SAMPLES_PER_MINUTE;
    const reserve = maxhr - rest;
    if (mean - rest >= 0.85 * reserve) zones.peak += 1;
    else if (mean - rest >= 0.6 * reserve) zones.vigorous += 1;
    else if (mean - rest >= 0.4 * reserve) zones.moderate += 1;
  }
  Object.assign(e, {
    hr_avg: hrSum / hrCount,
    hr_min: hrMin,
    hr_max: hrMax,
    azm: zones.moderate + 2 * (zones.vigorous + zones.peak),
    zone_moderate_minutes: zones.moderate,
    zone_vigorous_minutes: zones.vigorous,
    zone_peak_minutes: zones.peak,
  });

  let kcal = 0;
  let steps = 0;
  let meters = 0;
  for (let m = 0; m < 1440; m++) {
    const start = day0 + m * MINUTE;
    const inExercise = start >= exerciseStart && start < exerciseEnd;
    const calories = round2(inExercise ? 6 + random() * 3 : 1.1 + random() * 0.4);
    items.push([
      'total_calories',
      { calories, start_time: iso(start), end_time: iso(start + MINUTE), uuid: `kcal-${date}-${m}`, source: FITBIT },
    ]);
    kcal += calories;
    const walking = (m >= 480 && m < 765) || inExercise;
    if (walking) {
      const count = inExercise ? 120 + Math.floor(random() * 20) : 60 + Math.floor(random() * 50);
      const distance = round2(count * 0.75);
      items.push([
        'steps',
        { count, start_time: iso(start), end_time: iso(start + MINUTE), uuid: `steps-${date}-${m}`, source: FITBIT },
      ]);
      items.push([
        'distance',
        {
          meters: distance,
          start_time: iso(start),
          end_time: iso(start + MINUTE),
          uuid: `dist-${date}-${m}`,
          source: FITBIT,
        },
      ]);
      steps += count;
      meters += distance;
    }
  }
  Object.assign(e, { total_calories: kcal, steps, distance: meters });

  let spo2Sum = 0;
  let spo2Min = Infinity;
  for (let m = 0; m < 360; m++) {
    const ms = day0 + 30 * MINUTE + m * MINUTE;
    const percentage = 93 + Math.floor(random() * 6);
    items.push(['oxygen_saturation', { percentage, time: iso(ms), uuid: `spo2-${date}-${m}`, source: FITBIT }]);
    spo2Sum += percentage;
    spo2Min = Math.min(spo2Min, percentage);
  }
  Object.assign(e, { spo2_avg: spo2Sum / 360, spo2_min: spo2Min });

  let hrvSum = 0;
  for (let i = 0; i < 90; i++) {
    const millis = round2(20 + random() * 25);
    items.push([
      'heart_rate_variability',
      {
        heart_rate_variability_millis: millis,
        time: iso(sleepStart + i * 5 * MINUTE),
        uuid: `hrv-${date}-${i}`,
        source: FITBIT,
      },
    ]);
    hrvSum += millis;
  }
  e.hrv_rmssd = hrvSum / 90;

  const rate = round2(13 + random() * 3);
  items.push(['respiratory_rate', { rate, time: iso(sleepStart), uuid: `resp-${date}`, source: FITBIT }]);
  e.respiratory_rate = rate;

  let skinSum = 0;
  for (let h = 0; h < 8; h++) {
    const ms = sleepStart + h * 60 * MINUTE;
    const delta = round2(-0.5 + random());
    items.push([
      'skin_temperature',
      { delta_celsius: delta, time: iso(ms), uuid: `skin-${date}#${ms}`, source: FITBIT },
    ]);
    skinSum += delta;
  }
  e.skin_temp_delta = skinSum / 8;

  items.push([
    'exercise',
    {
      type: '79',
      start_time: iso(exerciseStart),
      end_time: iso(exerciseEnd),
      duration_seconds: 1800,
      uuid: `walk-${date}`,
      source: FITBIT,
    },
  ]);
  Object.assign(e, { exercise_count: 1, exercise_minutes: 30 });
  const vo2 = round2(42 + random() * 4);
  items.push(['vo2_max', { vo2_ml_per_min_per_kg: vo2, time: iso(exerciseEnd), uuid: `vo2-${date}`, source: FITBIT }]);
  e.vo2max = vo2;

  return { items, expected: e };
}

// Payloads as the exporter sends them: at most 1000 objects each, and every sample of a heart-rate
// or skin-temperature record in the same payload.
export function syntheticDataset(
  start: string,
  days: number,
  birthYear: number,
): { payloads: SyntheticPayload[]; days: SyntheticDay[] } {
  const payloads: SyntheticPayload[] = [];
  const out: SyntheticDay[] = [];
  let sequence = 1;
  let clock = Date.parse(`${addDaysIso(start, days)}T00:00:00Z`);
  let current: SyntheticPayload | null = null;
  let size = 0;
  for (let i = 0; i < days; i++) {
    const date = addDaysIso(start, i);
    const { items, expected } = syntheticDay(date, birthYear);
    out.push({ date, expected });
    const groups = new Map<string, [string, Item][]>();
    for (const [type, item] of items) {
      const uuid = String(item.uuid);
      const key = `${type}:${uuid.split('#')[0]}`;
      const group = groups.get(key) ?? [];
      group.push([type, item]);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (current === null || size + group.length > 1000) {
        clock += 1000;
        current = { timestamp: iso(clock), app_version: '1.21.2', source: 'health_connect', sequence: sequence++ };
        payloads.push(current);
        size = 0;
      }
      for (const [type, item] of group) {
        const list = current[type];
        if (Array.isArray(list)) list.push(item);
        else current[type] = [item];
      }
      size += group.length;
    }
  }
  return { payloads, days: out };
}
