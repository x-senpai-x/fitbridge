import { describe, expect, it } from 'vitest';
import bucketed from './fixtures/ldc-payload-bucketed.composed.json';
import deletions from './fixtures/ldc-payload-deletions.composed.json';
import sync from './fixtures/ldc-payload-sync.composed.json';
import { Envelope, parsePayload, type Payload, recordId } from '../src/payload';
import { clockFor } from '../src/time';

const clock = clockFor('Asia/Kolkata');
const FITBIT = 'com.fitbit.FitbitMobile';

function parse(payload: Payload) {
  return parsePayload(payload, Envelope.parse(payload), clock);
}

describe('parsePayload', () => {
  it('turns the composed sync payload into 15 rows with day attribution', () => {
    const parsed = parse(sync);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.rows).toHaveLength(15);
    const byType = Object.fromEntries(parsed.rows.map((r) => [r.type, r.local_date]));
    expect(byType).toEqual({
      steps: '2026-09-23',
      sleep: '2026-09-23',
      heart_rate: '2026-09-23',
      distance: '2026-09-23',
      total_calories: '2026-09-23',
      oxygen_saturation: '2026-09-23',
      respiratory_rate: '2026-09-23',
      resting_heart_rate: '2026-09-22',
      exercise: '2026-09-22',
      heart_rate_variability: '2026-09-23',
      vo2_max: '2026-09-22',
      skin_temperature: '2026-09-23',
    });
    expect(parsed.counts.heart_rate).toEqual({ [FITBIT]: 3 });
  });

  it('packs heart-rate samples by the uuid prefix before # with summary columns', () => {
    const hr = parse(sync).rows.find((r) => r.type === 'heart_rate');
    expect(hr).toEqual({
      type: 'heart_rate',
      id: '5b0c7a2e-1f3d-3c41-9a7e-2d4f6b8c0e11',
      source: FITBIT,
      start_ms: Date.parse('2026-09-23T05:30:02Z'),
      end_ms: Date.parse('2026-09-23T05:30:12Z'),
      local_date: '2026-09-23',
      value: 190 / 3,
      n: 3,
      vmin: 61,
      vmax: 66,
      body: '[[1790141402000,61],[1790141407000,63],[1790141412000,66]]',
      minutes: '[[1790141400000,3,190,61,66]]',
    });
  });

  it('summarizes heart-rate samples per minute and leaves other types without minutes', () => {
    const sample = (bpm: number, time: string) => ({ bpm, time, uuid: `r#${Date.parse(time)}`, source: FITBIT });
    const parsed = parse({
      timestamp: '2026-09-23T06:00:00Z',
      app_version: '1.21.2',
      source: 'health_connect',
      heart_rate: [
        sample(70, '2026-09-23T05:00:40Z'),
        sample(80, '2026-09-23T05:00:59.999Z'),
        sample(90, '2026-09-23T05:01:00Z'),
        sample(60, '2026-09-23T05:03:30Z'),
        sample(64, '2026-09-23T05:03:10Z'),
      ],
      skin_temperature: [{ delta_celsius: -0.3, time: '2026-09-23T05:00:00Z', uuid: 's#1', source: FITBIT }],
      steps: [{ count: 5, start_time: '2026-09-23T05:00:00Z', end_time: '2026-09-23T05:01:00Z', uuid: 'st', source: FITBIT }],
    });
    const byType = Object.fromEntries(parsed.rows.map((r) => [r.type, r.minutes]));
    expect(byType).toEqual({
      heart_rate: JSON.stringify([
        [Date.parse('2026-09-23T05:00:00Z'), 2, 150, 70, 80],
        [Date.parse('2026-09-23T05:01:00Z'), 1, 90, 90, 90],
        [Date.parse('2026-09-23T05:03:00Z'), 2, 124, 60, 64],
      ]),
      skin_temperature: null,
      steps: null,
    });
  });

  it('takes sample instants from time, not from the uuid suffix', () => {
    // The composed skin-temperature uuid suffix is a year off from its time field.
    const skin = parse(sync).rows.find((r) => r.type === 'skin_temperature');
    expect(skin?.id).toBe('8a0c2e4a-6c8e-3a0c-9e4a-6c8e0a2c4e76');
    expect(skin?.body).toBe(`[[${Date.parse('2026-09-22T22:01:00Z')},-0.3]]`);
  });

  it('sorts samples and keeps one value per instant', () => {
    const sample = (bpm: number, time: string) => ({ bpm, time, uuid: `r#${Date.parse(time)}`, source: FITBIT });
    const parsed = parse({
      timestamp: '2026-09-23T06:00:00Z',
      app_version: '1.21.2',
      source: 'health_connect',
      heart_rate: [
        sample(70, '2026-09-23T05:00:10Z'),
        sample(60, '2026-09-23T05:00:00Z'),
        sample(65, '2026-09-23T05:00:10Z'),
      ],
    });
    expect(parsed.rows[0]?.body).toBe(
      `[[${Date.parse('2026-09-23T05:00:00Z')},60],[${Date.parse('2026-09-23T05:00:10Z')},65]]`,
    );
    expect(parsed.rows[0]?.n).toBe(2);
  });

  it('attributes sleep to the wake date and stores the record fields as body', () => {
    const crossing = parse({
      timestamp: '2026-09-23T06:00:00Z',
      app_version: '1.21.2',
      source: 'health_connect',
      // 22:30 on 2026-09-22 to 06:00 on 2026-09-23 in Asia/Kolkata.
      sleep: [{ session_end_time: '2026-09-23T00:30:00Z', duration_seconds: 27000, uuid: 'night', source: FITBIT }],
    });
    expect(crossing.rows[0]?.local_date).toBe('2026-09-23');
    const sleep = parse(sync).rows.find((r) => r.type === 'sleep');
    expect(sleep?.start_ms).toBe(Date.parse('2026-09-22T22:01:00Z'));
    expect(sleep?.end_ms).toBe(Date.parse('2026-09-23T04:42:00Z'));
    expect(sleep?.value).toBe(401);
    expect(JSON.parse(sleep?.body ?? '{}')).toMatchObject({
      session_end_time: '2026-09-23T04:42:00Z',
      duration_seconds: 24060,
    });
  });

  it('maps deletions to record ids and keeps only known types', () => {
    const parsed = parse({
      ...deletions,
      deleted_records: [...deletions.deleted_records, { type: 'nutrition', uuid: 'n1' }],
    });
    expect(parsed.deletions).toEqual([
      { type: 'total_calories', id: '71a3c5e7-9b2d-3f40-8c6e-0a2c4e6a8c86' },
      { type: 'heart_rate', id: '5b0c7a2e-1f3d-3c41-9a7e-2d4f6b8c0e11' },
    ]);
    expect(recordId('abc#123')).toBe('abc');
    expect(recordId('abc')).toBe('abc');
  });

  it('rejects bucketed series, invalid records and unknown keys, keeping the raw text', () => {
    expect(parse(bucketed).rejected).toEqual([
      {
        type: 'heart_rate',
        reason: 'bucketed record: set this type to raw resolution in the exporter',
        raw: JSON.stringify(bucketed.heart_rate[0]),
      },
    ]);
    const parsed = parse({
      timestamp: '2026-09-23T06:00:00Z',
      app_version: '1.21.2',
      source: 'health_connect',
      heart_rate: [{ time: '2026-09-23T05:00:00Z', uuid: 'x#1', source: FITBIT }],
      weight: 'heavy',
      hydration: [{ liters: 0.5 }],
      surprise: { a: 1 },
    });
    expect(parsed.rejected.map((r) => [r.type, r.reason])).toEqual([
      ['heart_rate', 'bpm: Invalid input: expected number, received undefined'],
      ['weight', 'expected an array of records'],
      ['hydration', 'unknown type'],
      ['surprise', 'unknown key'],
    ]);
    expect(parsed.rows).toEqual([]);
  });

  it('refuses an envelope without timestamp, app_version or the health_connect source', () => {
    expect(Envelope.safeParse({ app_version: '1', source: 'health_connect' }).success).toBe(false);
    expect(
      Envelope.safeParse({ timestamp: '2026-09-23T06:00:00Z', app_version: '1', source: 'screen_time' }).success,
    ).toBe(false);
    expect(
      Envelope.safeParse({ timestamp: '2026-09-23T06:00:00Z', app_version: '1', source: 'health_connect' }).success,
    ).toBe(true);
  });
});
