import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import sync from './fixtures/ldc-payload-sync.composed.json';
import { callJson, callTool, cron, mcp, post, watchD1 } from './helpers';
import { syntheticDataset } from './synthetic';
import type { Table } from '../src/answer';
import { recomputeDirty } from '../src/daily';

const FITBIT = 'com.fitbit.FitbitMobile';
// Measured 2026-10-03 in local workerd D1 at synthetic Fitbit density: 3,135 rows read per workout (8,778 when the
// heart-rate summaries were not materialized and the join also scanned the day before the workout).
const WORKOUT_ROWS_READ = 3_500;

describe('get_sleep', () => {
  it('lists the session with stage minutes, and the timeline with detail stages', async () => {
    await post(sync);
    const client = await mcp();
    const answer = await callJson<{ sessions: Table; stages: Table }>(client, 'get_sleep', {
      start: '2026-09-23',
      end: '2026-09-23',
      detail: 'stages',
    });
    expect(answer.sessions.rows).toEqual([
      ['2026-09-23', '2026-09-23 03:31', '2026-09-23 10:12', true, 401, 393, 9, 324, 47, 23, 97.9],
    ]);
    expect(answer.stages.rows[0]).toEqual(['2026-09-23', '2026-09-23 03:31', 'awake', '03:31', '03:39', 8.5]);
    expect(answer.stages.rows).toHaveLength(5);
  });

  it('shows only the stage figures a session measured, never 0 for the rest', async () => {
    const stage = (stage: string, start: string, end: string) => ({
      stage,
      start_time: start,
      end_time: end,
      duration_seconds: (Date.parse(end) - Date.parse(start)) / 1000,
    });
    const session = (uuid: string, end: string, stages: ReturnType<typeof stage>[]) => ({
      session_end_time: end,
      duration_seconds: 3600,
      uuid,
      source: FITBIT,
      stages,
    });
    await post({
      timestamp: '2026-09-25T06:00:00Z',
      app_version: '1.21.2',
      source: 'health_connect',
      sleep: [
        session('basic', '2026-09-23T05:00:00Z', [
          stage('sleeping', '2026-09-23T04:00:00Z', '2026-09-23T04:50:00Z'),
          stage('awake', '2026-09-23T04:50:00Z', '2026-09-23T05:00:00Z'),
        ]),
        session('blank', '2026-09-24T05:00:00Z', [stage('unknown', '2026-09-24T04:00:00Z', '2026-09-24T05:00:00Z')]),
      ],
    });
    const client = await mcp();
    const answer = await callJson<{ sessions: Table }>(client, 'get_sleep', {
      start: '2026-09-23',
      end: '2026-09-24',
      detail: 'summary',
    });
    expect(answer.sessions.rows).toEqual([
      ['2026-09-23', '2026-09-23 09:30', '2026-09-23 10:30', true, 60, 50, 10, null, null, null, 83.3],
      ['2026-09-24', '2026-09-24 09:30', '2026-09-24 10:30', true, 60, null, null, null, null, null, null],
    ]);
  });

  it('gives coverage with an empty answer', async () => {
    await post(sync);
    await cron();
    const client = await mcp();
    const answer = await callJson<{ notes: string[]; coverage: object }>(client, 'get_sleep', {
      start: '2026-01-01',
      end: '2026-01-31',
      detail: 'summary',
    });
    expect(answer.notes[0]).toBe('no data for these dates');
    expect(answer.coverage).toEqual({ first_date: '2026-09-23', last_date: '2026-09-23' });
  });

  it('limits detail stages to 14 days', async () => {
    const client = await mcp();
    const result = await callTool(client, 'get_sleep', { start: '2026-09-01', end: '2026-09-30', detail: 'stages' });
    expect(result.text).toBe('range is 30 days; the limit with detail stages is 14, shorten it or use detail summary');
  });
});

describe('get_workouts', () => {
  it('names the type and computes heart rate and zones from the samples inside the workout', async () => {
    // One heart-rate record spanning the workout end: the two 180 bpm samples after 10:03 must not count.
    const samples: [string, number][] = [
      ['10:00:00', 120],
      ['10:00:20', 120],
      ['10:00:40', 120],
      ['10:01:00', 140],
      ['10:01:20', 140],
      ['10:01:40', 140],
      ['10:02:00', 170],
      ['10:02:20', 170],
      ['10:02:40', 170],
      ['10:03:20', 180],
      ['10:03:40', 180],
    ];
    await post({
      timestamp: '2026-09-23T12:00:00Z',
      app_version: '1.21.2',
      source: 'health_connect',
      resting_heart_rate: [{ bpm: 60, time: '2026-09-23T00:00:00Z', uuid: 'rhr', source: FITBIT }],
      exercise: [
        {
          type: '56',
          start_time: '2026-09-23T10:00:00Z',
          end_time: '2026-09-23T10:03:00Z',
          duration_seconds: 180,
          uuid: 'run',
          source: FITBIT,
        },
      ],
      heart_rate: samples.map(([t, bpm]) => {
        const time = `2026-09-23T${t}Z`;
        return { bpm, time, uuid: `w#${Date.parse(time)}`, source: FITBIT };
      }),
    });
    const client = await mcp();
    const answer = await callJson<{ workouts: Table }>(client, 'get_workouts', {
      start: '2026-09-23',
      end: '2026-09-23',
    });
    // BIRTH_YEAR 1990 and rest 60: 120 bpm is moderate, 140 vigorous, 170 peak.
    expect(answer.workouts.rows).toEqual([['2026-09-23', '2026-09-23 15:30', 'running', 3, 143.3, 170, 1, 1, 1]]);
  });

  it('reads under a fixed number of rows per workout at Fitbit density', { timeout: 60_000 }, async () => {
    const { payloads } = syntheticDataset('2026-09-01', 4, 1990);
    for (const payload of payloads) expect((await post(payload)).status).toBe(200);
    await recomputeDirty(env);
    const client = await mcp();
    const d1 = watchD1();
    const answer = await callJson<{ workouts: Table }>(client, 'get_workouts', {
      start: '2026-09-02',
      end: '2026-09-03',
    });
    const rows = await d1.rowsRead();
    vi.restoreAllMocks();
    expect(answer.workouts.rows.map((w) => [w[0], w[2], w[3], typeof w[4], typeof w[6]])).toEqual([
      ['2026-09-02', 'walking', 30, 'number', 'number'],
      ['2026-09-03', 'walking', 30, 'number', 'number'],
    ]);
    expect(rows / answer.workouts.rows.length).toBeLessThan(WORKOUT_ROWS_READ);
  });

  it('refuses more than 60 days', async () => {
    const client = await mcp();
    const result = await callTool(client, 'get_workouts', { start: '2026-07-01', end: '2026-08-30' });
    expect(result.text).toBe('range is 61 days; the limit for workouts is 60, split it');
  });
});

describe('get_workouts coverage', () => {
  it('gives coverage with an empty answer', async () => {
    await post(sync);
    await cron();
    const client = await mcp();
    const answer = await callJson<{ notes: string[]; coverage: object }>(client, 'get_workouts', {
      start: '2026-01-01',
      end: '2026-01-31',
    });
    expect(answer.notes[0]).toBe('no data for these dates');
    expect(answer.coverage).toEqual({ first_date: '2026-09-22', last_date: '2026-09-22' });
  });
});

describe('get_intraday', () => {
  it('buckets heart-rate samples on the local clock', async () => {
    await post(sync);
    const client = await mcp();
    const answer = await callJson<{ buckets: Table }>(client, 'get_intraday', {
      metric: 'heart_rate',
      start: '2026-09-23T05:00:00Z',
      end: '2026-09-23T06:00:00Z',
      resolution: '1m',
    });
    expect(answer.buckets.rows).toEqual([['2026-09-23 11:00', 61, 63.3, 66, 3]]);
  });

  it('shifts hourly buckets by the zone offset', async () => {
    await post(sync);
    const client = await mcp();
    const answer = await callJson<{ buckets: Table }>(client, 'get_intraday', {
      metric: 'heart_rate',
      start: '2026-09-23T05:00:00Z',
      end: '2026-09-23T06:00:00Z',
      resolution: '1h',
    });
    expect(answer.buckets.rows).toEqual([['2026-09-23 11:00', 61, 63.3, 66, 3]]);
  });

  it('gives the matching daily coverage with an empty answer', async () => {
    await post(sync);
    await cron();
    const client = await mcp();
    const answer = await callJson<{ notes: string[]; coverage: object }>(client, 'get_intraday', {
      metric: 'heart_rate',
      start: '2026-01-01T00:00:00Z',
      end: '2026-01-01T01:00:00Z',
      resolution: '1m',
    });
    expect(answer.notes[0]).toBe('no data for this range');
    expect(answer.coverage).toEqual({ first_date: '2026-09-23', last_date: '2026-09-23' });
  });

  it('weights a minute split across heart-rate records by its sample counts', async () => {
    const sample = (record: string, time: string, bpm: number) => {
      const ms = Date.parse(`2026-09-23T${time}Z`);
      return { bpm, time: new Date(ms).toISOString(), uuid: `${record}#${ms}`, source: FITBIT };
    };
    await post({
      timestamp: '2026-09-23T12:00:00Z',
      app_version: '1.21.2',
      source: 'health_connect',
      heart_rate: [
        sample('a', '05:00:00', 60),
        sample('b', '05:00:15', 130),
        sample('b', '05:00:30', 130),
        sample('b', '05:00:45', 130),
        sample('b', '05:01:10', 90),
      ],
    });
    const client = await mcp();
    const answer = await callJson<{ buckets: Table }>(client, 'get_intraday', {
      metric: 'heart_rate',
      start: '2026-09-23T05:00:00Z',
      end: '2026-09-23T05:10:00Z',
      resolution: '1m',
    });
    // (60 + 3 * 130) / 4 = 112.5; the mean of the two records' means would be 95.
    expect(answer.buckets.rows).toEqual([
      ['2026-09-23 10:30', 60, 112.5, 130, 4],
      ['2026-09-23 10:31', 90, 90, 90, 1],
    ]);
  });

  it('refuses more than 48 hours and too many buckets', async () => {
    const client = await mcp();
    const long = await callTool(client, 'get_intraday', {
      metric: 'steps',
      start: '2026-09-20T00:00:00Z',
      end: '2026-09-22T01:00:00Z',
      resolution: '1h',
    });
    expect(long.text).toBe('range is 49 hours; the limit is 48, split it or use get_daily_summary');
    const fine = await callTool(client, 'get_intraday', {
      metric: 'heart_rate',
      start: '2026-09-20T00:00:00Z',
      end: '2026-09-22T00:00:00Z',
      resolution: '1m',
    });
    expect(fine.text).toBe('1m over this range is 2880 buckets; the limit is 1000, use 5m or a shorter range');
  });
});
