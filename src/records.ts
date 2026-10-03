import { z } from 'zod';

export const RECORD_TYPES = [
  'heart_rate',
  'heart_rate_variability',
  'resting_heart_rate',
  'respiratory_rate',
  'oxygen_saturation',
  'skin_temperature',
  'sleep',
  'exercise',
  'steps',
  'distance',
  'total_calories',
  'vo2_max',
  'weight',
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const isoTime = z.iso.datetime({ offset: true });

export interface Reading {
  uuid: string;
  source: string;
  startMs: number;
  endMs: number;
  value: number;
  body: string;
}

const identity = { uuid: z.string().min(1), source: z.string().min(1) };

export const SCHEMAS: Record<RecordType, z.ZodType<Reading>> = {
  heart_rate: z
    .object({ bpm: z.number(), time: isoTime, ...identity })
    .transform(({ uuid, source, ...f }) => instant(uuid, source, f.time, f.bpm, f)),
  heart_rate_variability: z
    .object({ heart_rate_variability_millis: z.number(), time: isoTime, ...identity })
    .transform(({ uuid, source, ...f }) => instant(uuid, source, f.time, f.heart_rate_variability_millis, f)),
  resting_heart_rate: z
    .object({ bpm: z.number(), time: isoTime, ...identity })
    .transform(({ uuid, source, ...f }) => instant(uuid, source, f.time, f.bpm, f)),
  respiratory_rate: z
    .object({ rate: z.number(), time: isoTime, ...identity })
    .transform(({ uuid, source, ...f }) => instant(uuid, source, f.time, f.rate, f)),
  oxygen_saturation: z
    .object({ percentage: z.number(), time: isoTime, ...identity })
    .transform(({ uuid, source, ...f }) => instant(uuid, source, f.time, f.percentage, f)),
  skin_temperature: z
    .object({ delta_celsius: z.number(), baseline_celsius: z.number().optional(), time: isoTime, ...identity })
    .transform(({ uuid, source, ...f }) => instant(uuid, source, f.time, f.delta_celsius, f)),
  vo2_max: z
    .object({ vo2_ml_per_min_per_kg: z.number(), time: isoTime, ...identity })
    .transform(({ uuid, source, ...f }) => instant(uuid, source, f.time, f.vo2_ml_per_min_per_kg, f)),
  weight: z
    .object({ kilograms: z.number(), time: isoTime, ...identity })
    .transform(({ uuid, source, ...f }) => instant(uuid, source, f.time, f.kilograms, f)),
  steps: z
    .object({ count: z.number(), start_time: isoTime, end_time: isoTime, ...identity })
    .transform(({ uuid, source, ...f }) => interval(uuid, source, f.start_time, f.end_time, f.count, f)),
  distance: z
    .object({ meters: z.number(), start_time: isoTime, end_time: isoTime, ...identity })
    .transform(({ uuid, source, ...f }) => interval(uuid, source, f.start_time, f.end_time, f.meters, f)),
  total_calories: z
    .object({ calories: z.number(), start_time: isoTime, end_time: isoTime, ...identity })
    .transform(({ uuid, source, ...f }) => interval(uuid, source, f.start_time, f.end_time, f.calories, f)),
  exercise: z
    .object({
      type: z.string(),
      start_time: isoTime,
      end_time: isoTime,
      duration_seconds: z.number().int().optional(),
      ...identity,
    })
    .transform(({ uuid, source, ...f }) => {
      const minutes = (Date.parse(f.end_time) - Date.parse(f.start_time)) / 60_000;
      return interval(uuid, source, f.start_time, f.end_time, minutes, f);
    }),
  sleep: z
    .object({
      session_end_time: isoTime,
      duration_seconds: z.number().int().nonnegative(),
      stages: z
        .array(
          z.object({
            stage: z.string(),
            start_time: isoTime,
            end_time: isoTime,
            duration_seconds: z.number().int().optional(),
          }),
        )
        .default([]),
      ...identity,
    })
    .transform(({ uuid, source, ...f }) => {
      const endMs = Date.parse(f.session_end_time);
      const startMs = endMs - f.duration_seconds * 1000;
      return { uuid, source, startMs, endMs, value: f.duration_seconds / 60, body: JSON.stringify(f) };
    }),
};

function instant(uuid: string, source: string, time: string, value: number, fields: object): Reading {
  const ms = Date.parse(time);
  return { uuid, source, startMs: ms, endMs: ms, value, body: JSON.stringify(fields) };
}

function interval(uuid: string, source: string, start: string, end: string, value: number, fields: object): Reading {
  return { uuid, source, startMs: Date.parse(start), endMs: Date.parse(end), value, body: JSON.stringify(fields) };
}

export function isRecordType(key: string): key is RecordType {
  return (RECORD_TYPES as readonly string[]).includes(key);
}
