import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import deletions from './fixtures/ldc-payload-deletions.composed.json';
import sync from './fixtures/ldc-payload-sync.composed.json';
import { cron, post, watchD1 } from './helpers';
import { syntheticDataset } from './synthetic';
import { MAX_CRON_DAY_RECOMPUTES, MAX_RECOMPUTE_QUERIES, recomputeDays, recomputeDirty } from '../src/daily';
import { addDays } from '../src/time';
import { dailySummary } from '../src/tools/daily-summary';

const FITBIT = 'com.fitbit.FitbitMobile';
// Measured 2026-10-03 in local workerd D1: one full synthetic day reads 10,428 rows to recompute (78,163 from raw samples).
const FULL_DAY_ROWS_READ = 11_000;

async function daily(date: string): Promise<Record<string, number>> {
  const rows = await env.DB.prepare('SELECT metric, value FROM daily WHERE local_date = ?1 ORDER BY metric')
    .bind(date)
    .all<{ metric: string; value: number }>();
  return Object.fromEntries(rows.results.map((r) => [r.metric, r.value]));
}

function hrSamples(recordId: string, startIso: string, bpms: number[], stepMs = 5000): object[] {
  const start = Date.parse(startIso);
  return bpms.map((bpm, i) => {
    const ms = start + i * stepMs;
    return { bpm, time: new Date(ms).toISOString(), uuid: `${recordId}#${ms}`, source: FITBIT };
  });
}

function sleepOn(uuid: string, sessionEnd: string, minutes: number, stages: [string, string, string][]): object {
  return {
    session_end_time: sessionEnd,
    duration_seconds: minutes * 60,
    uuid,
    source: FITBIT,
    stages: stages.map(([stage, start_time, end_time]) => ({ stage, start_time, end_time })),
  };
}

// BIRTH_YEAR 1990 -> age 36 in 2026 -> max 184; rest 60 -> reserve 124.
// Zone floors: moderate 109.6, vigorous 134.4, peak 165.4.
const ZONE_DAY = {
  timestamp: '2026-09-23T18:00:00Z',
  app_version: '1.21.2',
  source: 'health_connect',
  resting_heart_rate: [{ bpm: 60, time: '2026-09-23T00:00:00Z', uuid: 'rhr', source: FITBIT }],
  heart_rate: [
    ...hrSamples('m1', '2026-09-23T10:00:00Z', [100, 100]),
    ...hrSamples('m2', '2026-09-23T10:01:00Z', [109, 109]),
    ...hrSamples('m3', '2026-09-23T10:02:00Z', [109, 111]),
    ...hrSamples('m4', '2026-09-23T10:03:00Z', [140, 140]),
    ...hrSamples('m5', '2026-09-23T10:04:00Z', [170, 166]),
  ],
};

describe('daily derivation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('derives every metric of the composed sync payload', async () => {
    await post(sync);
    expect(await recomputeDirty(env)).toEqual([]);
    expect(await daily('2026-09-22')).toEqual({ exercise_count: 1, exercise_minutes: 36, resting_hr: 56, vo2max: 44 });
    const day = await daily('2026-09-23');
    expect(day).toEqual({
      bedtime: Date.parse('2026-09-22T22:01:00Z'),
      distance: 28.4,
      hr_avg: 190 / 3,
      hr_max: 66,
      hr_min: 61,
      hrv_rmssd: 26.1,
      naps: 0,
      respiratory_rate: 14.6,
      skin_temp_delta: -0.3,
      sleep_awake_minutes: 8.5,
      sleep_deep_minutes: 46.5,
      sleep_efficiency: (100 * 392.5) / 401,
      sleep_in_bed_minutes: 401,
      sleep_light_minutes: 323.5,
      sleep_minutes: 392.5,
      sleep_rem_minutes: 22.5,
      spo2_avg: 95,
      spo2_min: 95,
      steps: 150,
      total_calories: 2.54,
      wake_time: Date.parse('2026-09-23T04:42:00Z'),
    });
    expect(await daily('2026-09-24')).toEqual({});
  });

  it('estimates active zone minutes from one-minute means and that day resting heart rate', async () => {
    await post(ZONE_DAY);
    await recomputeDirty(env);
    expect(await daily('2026-09-23')).toMatchObject({
      azm: 5,
      zone_moderate_minutes: 1,
      zone_vigorous_minutes: 1,
      zone_peak_minutes: 1,
      resting_hr: 60,
    });
  });

  it('replaces the minute summaries of a heart-rate record that is sent again with different samples', async () => {
    const minuteApart = (bpms: number[]): object[] =>
      bpms.flatMap((bpm, i) =>
        hrSamples('hr', new Date(Date.parse('2026-09-23T10:00:00Z') + i * 60_000).toISOString(), [bpm, bpm]),
      );
    await post({ ...ZONE_DAY, heart_rate: minuteApart([100, 110, 140, 170]) });
    await recomputeDirty(env);
    expect(await daily('2026-09-23')).toMatchObject({ azm: 5 });
    await post({ ...ZONE_DAY, timestamp: '2026-09-23T19:00:00Z', heart_rate: minuteApart([100, 100]) });
    await recomputeDirty(env);
    expect(await daily('2026-09-23')).toMatchObject({
      azm: 0,
      zone_moderate_minutes: 0,
      zone_vigorous_minutes: 0,
      zone_peak_minutes: 0,
    });
  });

  it('weights a minute split across two heart-rate records by its sample counts', async () => {
    await post({
      ...ZONE_DAY,
      // One sample of 60 and three of 130 in the 10:00 minute: (60 + 3 * 130) / 4 = 112.5, moderate.
      // The mean of the two records' means, (60 + 130) / 2 = 95, would be no zone.
      heart_rate: [
        ...hrSamples('a', '2026-09-23T10:00:00Z', [60]),
        ...hrSamples('b', '2026-09-23T10:00:15Z', [130, 130, 130], 15_000),
      ],
    });
    await recomputeDirty(env);
    expect(await daily('2026-09-23')).toMatchObject({
      azm: 1,
      zone_moderate_minutes: 1,
      zone_vigorous_minutes: 0,
      zone_peak_minutes: 0,
    });
  });

  it('computes zones only with BIRTH_YEAR, and says so when it is empty', async () => {
    await post(ZONE_DAY);
    await recomputeDirty(env);
    expect(await daily('2026-09-23')).toMatchObject({ azm: 5, resting_hr: 60 });
    const unset = { ...env, BIRTH_YEAR: '' };
    await recomputeDays(unset, ['2026-09-23']);
    const day = await daily('2026-09-23');
    expect(day.resting_hr).toBe(60);
    expect(Object.keys(day).filter((m) => m === 'azm' || m.startsWith('zone_'))).toEqual([]);
    const answer = await dailySummary(unset, '2026-09-23', '2026-09-23', ['azm', 'resting_hr']);
    expect(answer.daily).toEqual({ columns: ['date', 'azm', 'resting_hr'], rows: [['2026-09-23', null, 60]] });
    expect(answer.notes).toContain(
      'azm and zone minutes need the BIRTH_YEAR variable, which is not set, so they are absent.',
    );
  });

  it('attributes a sleep across local midnight to the wake date, with night samples from the evening before', async () => {
    const payload = {
      timestamp: '2026-09-23T06:00:00Z',
      app_version: '1.21.2',
      source: 'health_connect',
      sleep: [
        {
          // 22:30 to 06:00 in Asia/Kolkata.
          session_end_time: '2026-09-23T00:30:00Z',
          duration_seconds: 27000,
          uuid: 'night',
          source: FITBIT,
          stages: [
            { stage: 'light', start_time: '2026-09-22T17:00:00Z', end_time: '2026-09-22T21:00:00Z' },
            { stage: 'deep', start_time: '2026-09-22T21:00:00Z', end_time: '2026-09-23T00:30:00Z' },
          ],
        },
        { session_end_time: '2026-09-23T09:30:00Z', duration_seconds: 1800, uuid: 'nap', source: FITBIT, stages: [] },
      ],
      heart_rate_variability: [
        { heart_rate_variability_millis: 30, time: '2026-09-22T18:00:00Z', uuid: 'hrv-evening', source: FITBIT },
        { heart_rate_variability_millis: 40, time: '2026-09-22T23:00:00Z', uuid: 'hrv-morning', source: FITBIT },
        { heart_rate_variability_millis: 99, time: '2026-09-23T03:00:00Z', uuid: 'hrv-awake', source: FITBIT },
      ],
    };
    await post(payload);
    await recomputeDirty(env);
    const day = await daily('2026-09-23');
    expect(day).toMatchObject({
      hrv_rmssd: 35,
      naps: 1,
      sleep_in_bed_minutes: 450,
      sleep_minutes: 450,
      sleep_efficiency: 100,
    });
    expect(day.bedtime).toBe(Date.parse('2026-09-22T17:00:00Z'));
    expect(await daily('2026-09-22')).toEqual({});
  });

  it('folds night samples that arrive in a later payload into the wake date', async () => {
    const base = { app_version: '1.21.2', source: 'health_connect' };
    await post({
      ...base,
      timestamp: '2026-09-23T01:00:00Z',
      sleep: [
        {
          session_end_time: '2026-09-23T00:30:00Z',
          duration_seconds: 27000,
          uuid: 'night',
          source: FITBIT,
          stages: [],
        },
      ],
    });
    await recomputeDirty(env);
    expect((await daily('2026-09-23')).hrv_rmssd).toBeUndefined();
    // Google Health uploads HRV an hour later; this sample is on the evening before, local date 2026-09-22.
    await post({
      ...base,
      timestamp: '2026-09-23T02:00:00Z',
      heart_rate_variability: [
        { heart_rate_variability_millis: 31, time: '2026-09-22T18:00:00Z', uuid: 'late', source: FITBIT },
      ],
    });
    await recomputeDirty(env);
    expect((await daily('2026-09-23')).hrv_rmssd).toBe(31);
  });

  it('shows in-bed time but no asleep minutes or efficiency for a main sleep without stages', async () => {
    await post({
      timestamp: '2026-09-23T06:00:00Z',
      app_version: '1.21.2',
      source: 'health_connect',
      sleep: [{ session_end_time: '2026-09-23T00:30:00Z', duration_seconds: 5400, uuid: 'short', source: FITBIT }],
    });
    await recomputeDirty(env);
    expect(await daily('2026-09-23')).toEqual({
      bedtime: Date.parse('2026-09-22T23:00:00Z'),
      naps: 0,
      sleep_in_bed_minutes: 90,
      wake_time: Date.parse('2026-09-23T00:30:00Z'),
    });
  });

  it('leaves light, deep and REM absent for a sleep with only generic sleeping and awake stages', async () => {
    await post({
      timestamp: '2026-09-24T06:00:00Z',
      app_version: '1.21.2',
      source: 'health_connect',
      sleep: [
        sleepOn('classic', '2026-09-23T04:30:00Z', 450, [
          ['sleeping', '2026-09-22T21:00:00Z', '2026-09-23T03:00:00Z'],
          ['awake', '2026-09-23T03:00:00Z', '2026-09-23T04:30:00Z'],
        ]),
        // Light and deep but no REM stage: REM is a measured 0.
        sleepOn('staged', '2026-09-24T04:30:00Z', 450, [
          ['light', '2026-09-23T21:00:00Z', '2026-09-24T01:00:00Z'],
          ['deep', '2026-09-24T01:00:00Z', '2026-09-24T04:30:00Z'],
        ]),
      ],
    });
    await recomputeDirty(env);
    expect(await daily('2026-09-23')).toEqual({
      bedtime: Date.parse('2026-09-22T21:00:00Z'),
      naps: 0,
      sleep_awake_minutes: 90,
      sleep_efficiency: 80,
      sleep_in_bed_minutes: 450,
      sleep_minutes: 360,
      wake_time: Date.parse('2026-09-23T04:30:00Z'),
    });
    expect(await daily('2026-09-24')).toMatchObject({
      sleep_light_minutes: 240,
      sleep_deep_minutes: 210,
      sleep_rem_minutes: 0,
      sleep_awake_minutes: 0,
      sleep_minutes: 450,
    });
  });

  it('leaves asleep minutes and efficiency absent for a sleep whose only stage is unknown', async () => {
    await post({
      timestamp: '2026-09-23T06:00:00Z',
      app_version: '1.21.2',
      source: 'health_connect',
      sleep: [
        sleepOn('unknown', '2026-09-23T04:30:00Z', 450, [['unknown', '2026-09-22T21:00:00Z', '2026-09-23T04:30:00Z']]),
      ],
    });
    await recomputeDirty(env);
    expect(await daily('2026-09-23')).toEqual({
      bedtime: Date.parse('2026-09-22T21:00:00Z'),
      naps: 0,
      sleep_in_bed_minutes: 450,
      wake_time: Date.parse('2026-09-23T04:30:00Z'),
    });
  });

  it('sums only the primary source', async () => {
    const payload = {
      timestamp: '2026-09-23T06:00:00Z',
      app_version: '1.21.2',
      source: 'health_connect',
      steps: [
        { count: 100, start_time: '2026-09-23T05:00:00Z', end_time: '2026-09-23T05:01:00Z', uuid: 'f', source: FITBIT },
        {
          count: 900,
          start_time: '2026-09-23T05:00:00Z',
          end_time: '2026-09-23T05:01:00Z',
          uuid: 'p',
          source: 'com.google.android.apps.fitness',
        },
      ],
    };
    await post(payload);
    await recomputeDirty(env);
    expect(await daily('2026-09-23')).toEqual({ steps: 100 });
  });

  it('drops deleted records from the day', async () => {
    await post(sync);
    await recomputeDirty(env);
    await post(deletions);
    await recomputeDirty(env);
    const day = await daily('2026-09-23');
    expect(day.total_calories).toBe(1.27);
    expect(day.hr_avg).toBeUndefined();
  });

  it('recomputes at most MAX_CRON_DAY_RECOMPUTES days per cron run, newest first, with one cleanup and three recomputation calls', async () => {
    const dates = Array.from({ length: 40 }, (_, i) => addDays('2026-07-01', i));
    await env.DB.batch(dates.map((d) => env.DB.prepare('INSERT INTO dirty_days (local_date) VALUES (?1)').bind(d)));
    const d1 = watchD1();
    await cron();
    // One authentication-state cleanup batch in addition to the three recomputation calls.
    expect(d1.queries()).toBe(4);
    vi.restoreAllMocks();
    // Seven consecutive seeds recompute eight days (the seeds and the day after the newest).
    const left = await env.DB.prepare('SELECT local_date FROM dirty_days ORDER BY 1').all<{ local_date: string }>();
    expect(MAX_CRON_DAY_RECOMPUTES).toBe(8);
    expect(left.results.map((r) => r.local_date)).toEqual(dates.slice(0, 33));
  });

  it('counts the next day each seed also recomputes, so scattered seeds do not double the bound', async () => {
    const seeds = ['07-01', '07-05', '07-09', '07-13', '07-17', '07-21', '07-25', '07-29'].map((d) => `2026-${d}`);
    await env.DB.batch(seeds.map((d) => env.DB.prepare('INSERT INTO dirty_days (local_date) VALUES (?1)').bind(d)));
    const targets: string[] = [];
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => {
        if (sql.startsWith('INSERT INTO daily') && typeof values[0] === 'string') targets.push(values[0]);
        return bind(...values);
      };
      return statement;
    });
    await cron();
    vi.restoreAllMocks();
    expect(new Set(targets.flatMap((t) => JSON.parse(t) as string[])).size).toBe(MAX_CRON_DAY_RECOMPUTES);
    const left = await env.DB.prepare('SELECT local_date FROM dirty_days ORDER BY 1').all<{ local_date: string }>();
    expect(left.results.map((r) => r.local_date)).toEqual(seeds.slice(0, 4));
  });

  it('bounds a tool recompute in D1 queries', async () => {
    const dates = Array.from({ length: 40 }, (_, i) => addDays('2026-07-01', i));
    await env.DB.batch(dates.map((d) => env.DB.prepare('INSERT INTO dirty_days (local_date) VALUES (?1)').bind(d)));
    const d1 = watchD1();
    await recomputeDirty(env);
    expect(d1.queries()).toBe(MAX_RECOMPUTE_QUERIES);
    expect(MAX_RECOMPUTE_QUERIES).toBeLessThanOrEqual(10);
  });

  it('reads under a fixed number of rows to recompute a full day at Fitbit density', { timeout: 60_000 }, async () => {
    const { payloads, days } = syntheticDataset('2026-09-01', 1, 1990);
    for (const payload of payloads) expect((await post(payload)).status).toBe(200);
    const d1 = watchD1();
    await recomputeDays(env, ['2026-09-01']);
    const rows = await d1.rowsRead();
    vi.restoreAllMocks();
    expect((await daily('2026-09-01')).azm).toBe(days[0]?.expected.azm);
    expect(rows).toBeLessThan(FULL_DAY_ROWS_READ);
  });

  it('limits a ranged recompute to the range and the day before it', async () => {
    await env.DB.batch(
      ['2026-09-01', '2026-09-09', '2026-09-10', '2026-09-20'].map((d) =>
        env.DB.prepare('INSERT INTO dirty_days (local_date) VALUES (?1)').bind(d),
      ),
    );
    expect(await recomputeDirty(env, { start: '2026-09-10', end: '2026-09-12' })).toEqual([]);
    const left = await env.DB.prepare('SELECT local_date FROM dirty_days ORDER BY 1').all<{ local_date: string }>();
    expect(left.results.map((r) => r.local_date)).toEqual(['2026-09-01', '2026-09-20']);
  });
});
