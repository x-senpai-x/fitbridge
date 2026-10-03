export const METRIC_NAMES = [
  'steps',
  'distance',
  'total_calories',
  'resting_hr',
  'hr_avg',
  'hr_min',
  'hr_max',
  'hrv_rmssd',
  'respiratory_rate',
  'skin_temp_delta',
  'spo2_avg',
  'spo2_min',
  'sleep_minutes',
  'sleep_awake_minutes',
  'sleep_light_minutes',
  'sleep_deep_minutes',
  'sleep_rem_minutes',
  'sleep_in_bed_minutes',
  'sleep_efficiency',
  'bedtime',
  'wake_time',
  'naps',
  'exercise_count',
  'exercise_minutes',
  'azm',
  'zone_moderate_minutes',
  'zone_vigorous_minutes',
  'zone_peak_minutes',
  'vo2max',
  'weight',
] as const;
export type DailyMetric = (typeof METRIC_NAMES)[number];

export const METRIC_INFO: Record<DailyMetric, { unit: string; digits: number }> = {
  steps: { unit: 'count', digits: 0 },
  distance: { unit: 'm', digits: 0 },
  total_calories: { unit: 'kcal', digits: 0 },
  resting_hr: { unit: 'bpm', digits: 0 },
  hr_avg: { unit: 'bpm', digits: 1 },
  hr_min: { unit: 'bpm', digits: 0 },
  hr_max: { unit: 'bpm', digits: 0 },
  hrv_rmssd: { unit: 'ms', digits: 1 },
  respiratory_rate: { unit: 'breaths/min', digits: 1 },
  skin_temp_delta: { unit: '°C', digits: 2 },
  spo2_avg: { unit: '%', digits: 1 },
  spo2_min: { unit: '%', digits: 1 },
  sleep_minutes: { unit: 'min', digits: 0 },
  sleep_awake_minutes: { unit: 'min', digits: 0 },
  sleep_light_minutes: { unit: 'min', digits: 0 },
  sleep_deep_minutes: { unit: 'min', digits: 0 },
  sleep_rem_minutes: { unit: 'min', digits: 0 },
  sleep_in_bed_minutes: { unit: 'min', digits: 0 },
  sleep_efficiency: { unit: '%', digits: 1 },
  bedtime: { unit: 'local HH:MM', digits: 0 },
  wake_time: { unit: 'local HH:MM', digits: 0 },
  naps: { unit: 'count', digits: 0 },
  exercise_count: { unit: 'count', digits: 0 },
  exercise_minutes: { unit: 'min', digits: 0 },
  azm: { unit: 'min', digits: 0 },
  zone_moderate_minutes: { unit: 'min', digits: 0 },
  zone_vigorous_minutes: { unit: 'min', digits: 0 },
  zone_peak_minutes: { unit: 'min', digits: 0 },
  vo2max: { unit: 'ml/kg/min', digits: 1 },
  weight: { unit: 'kg', digits: 1 },
};

export const CLOCK_METRICS: ReadonlySet<DailyMetric> = new Set<DailyMetric>(['bedtime', 'wake_time']);
const NIGHT_METRICS: ReadonlySet<DailyMetric> = new Set<DailyMetric>([
  'hrv_rmssd',
  'skin_temp_delta',
  'spo2_avg',
  'spo2_min',
  'respiratory_rate',
]);
const ZONE_METRICS: ReadonlySet<DailyMetric> = new Set<DailyMetric>([
  'azm',
  'zone_moderate_minutes',
  'zone_vigorous_minutes',
  'zone_peak_minutes',
]);
const SLEEP_METRICS: ReadonlySet<DailyMetric> = new Set<DailyMetric>([
  'sleep_minutes',
  'sleep_awake_minutes',
  'sleep_light_minutes',
  'sleep_deep_minutes',
  'sleep_rem_minutes',
  'sleep_in_bed_minutes',
  'sleep_efficiency',
  'bedtime',
  'wake_time',
  'naps',
]);

export function metricNotes(metrics: readonly DailyMetric[], env: Env, birthYearSet: boolean): string[] {
  const notes = [
    `Dates are local dates in ${env.TIMEZONE}; data recorded while travelling is still attributed in this zone.`,
    'Days with no data are omitted, never zero-filled.',
    `Daily figures use records from ${env.PRIMARY_SOURCE} only.`,
  ];
  if (metrics.some((m) => SLEEP_METRICS.has(m))) {
    notes.push(
      'Sleep belongs to the date you wake up; the main sleep is the longest session ending that date, and naps counts the others.',
    );
  }
  if (metrics.some((m) => NIGHT_METRICS.has(m))) {
    notes.push(
      'hrv_rmssd, respiratory_rate, skin_temp_delta and spo2 are means of the samples inside the main sleep, so they can differ slightly from the single nightly number Google Health shows.',
    );
  }
  if (metrics.some((m) => ZONE_METRICS.has(m))) {
    notes.push(
      birthYearSet
        ? "azm and zone minutes are an estimate: each minute's mean heart rate placed in Fitbit's published heart-rate-reserve zones (max HR 220 minus age from BIRTH_YEAR, with that day's resting HR); Google Health's own figure can differ."
        : 'azm and zone minutes need the BIRTH_YEAR variable, which is not set, so they are absent.',
    );
  }
  if (metrics.some((m) => CLOCK_METRICS.has(m))) {
    notes.push('bedtime and wake_time are local clock times of the main sleep.');
  }
  return notes;
}
