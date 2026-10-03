import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import backfill from './fixtures/ldc-payload-backfill.composed.json';
import bucketed from './fixtures/ldc-payload-bucketed.composed.json';
import deletions from './fixtures/ldc-payload-deletions.composed.json';
import sync from './fixtures/ldc-payload-sync.composed.json';
import syncMin from './fixtures/ldc-payload-sync.composed.min.json?raw';
import syncSig from './fixtures/ldc-payload-sync.composed.min.json.sig?raw';
import ping from './fixtures/ldc-payload-test-ping.composed.json';
import { cron, post, withTimestamp } from './helpers';
import { secondsUntilUtcMidnight, utcDay } from '../src/time';

const HR = '5b0c7a2e-1f3d-3c41-9a7e-2d4f6b8c0e11';
const KCAL = '71a3c5e7-9b2d-3f40-8c6e-0a2c4e6a8c86';

async function all<T>(sql: string): Promise<T[]> {
  return (await env.DB.prepare(sql).all<T>()).results;
}

async function budget(): Promise<number> {
  const row = await env.DB.prepare('SELECT rows FROM write_budget').first<{ rows: number }>();
  return row?.rows ?? 0;
}

describe('POST /ingest', () => {
  it('accepts the exporter bytes with the exporter signature and packs heart rate', async () => {
    const signature = /X-Signature: (sha256=[0-9a-f]{64})/.exec(syncSig)?.[1];
    const res = await post(syncMin, signature);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', records: 15, deletions: 0, rejected: 0 });
    const hr = await all<Record<string, string | number>>(`SELECT * FROM records WHERE type = 'heart_rate'`);
    expect(hr).toEqual([
      {
        type: 'heart_rate',
        id: HR,
        source: 'com.fitbit.FitbitMobile',
        start_ms: 1790141402000,
        end_ms: 1790141412000,
        local_date: '2026-09-23',
        value: 190 / 3,
        n: 3,
        vmin: 61,
        vmax: 66,
        body: '[[1790141402000,61],[1790141407000,63],[1790141412000,66]]',
        minutes: '[[1790141400000,3,190,61,66]]',
        observed_ms: Date.parse('2026-09-23T05:48:12.431Z'),
        deleted: 0,
      },
    ]);
    // Ingest only marks the days; the cron or a tool recomputes them later.
    expect(await all(`SELECT local_date FROM dirty_days ORDER BY local_date`)).toEqual([
      { local_date: '2026-09-22' },
      { local_date: '2026-09-23' },
    ]);
    expect(await all('SELECT * FROM daily')).toEqual([]);
    // 15 new records x 2 writes (row + unique index) + 2 dirty days + 1 ingest_log row (+ its received_ms index entry) + 1 budget row.
    expect(await budget()).toBe(35);
  });

  it('refuses a bad or missing signature with 401 and writes nothing', async () => {
    expect((await post(sync, 'sha256=' + '0'.repeat(64))).status).toBe(401);
    expect((await post(syncMin, '')).status).toBe(401);
    expect(await all('SELECT * FROM ingest_log')).toEqual([]);
    expect(await budget()).toBe(0);
  });

  it('refuses broken bodies with 400 and logs the reason', async () => {
    expect((await post('{not json')).status).toBe(400);
    expect((await post('[1,2]')).status).toBe(400);
    expect((await post({ timestamp: 'yesterday', source: 'health_connect' })).status).toBe(400);
    const rows = await all<{ status: number; error: string }>('SELECT status, error FROM ingest_log ORDER BY id');
    expect(rows.map((r) => r.status)).toEqual([400, 400, 400]);
    expect(rows[0]?.error).toBe('body is not JSON');
    expect(rows[1]?.error).toBe('body is not a JSON object');
    expect(rows[2]?.error).toMatch(/^invalid envelope: /);
  });

  it('refuses a body over 10 MB with 413', async () => {
    const res = await post('x'.repeat(10 * 1024 * 1024 + 1), 'sha256=' + '0'.repeat(64));
    expect(res.status).toBe(413);
  });

  it('answers the test ping with 200 and logs it', async () => {
    const res = await post(ping);
    expect(res.status).toBe(200);
    expect(await all('SELECT kind, status FROM ingest_log')).toEqual([{ kind: 'test', status: 200 }]);
  });

  it('stores invalid records, unknown keys and bucketed series in rejected_records', async () => {
    const payload = {
      ...withTimestamp(sync, '2026-09-23T05:48:12.431Z'),
      steps: [{ count: 5, start_time: '2026-09-23T05:31:00Z', uuid: 'no-end', source: 'com.fitbit.FitbitMobile' }],
      nutrition: [{ calories: 450, uuid: 'n1', source: 'com.cronometer.android.gold' }],
    };
    const res = await post(payload);
    expect(res.status).toBe(200);
    expect((await post(bucketed)).status).toBe(200);
    const rejected = await all<{ type: string; reason: string }>(
      'SELECT type, reason FROM rejected_records ORDER BY id',
    );
    expect(rejected).toEqual([
      { type: 'steps', reason: 'end_time: Invalid input: expected string, received undefined' },
      { type: 'nutrition', reason: 'unknown type' },
      { type: 'heart_rate', reason: 'bucketed record: set this type to raw resolution in the exporter' },
    ]);
  });

  it('logs sequence, counts, backfill window and data-quality fields', async () => {
    await post(sync);
    await post(deletions);
    await post(backfill);
    const rows = await all<Record<string, string | number | null>>(
      `SELECT kind, sequence, counts, deletions, backfill_window, deletions_unavailable, records_outside_window FROM ingest_log ORDER BY id`,
    );
    expect(rows[0]).toMatchObject({ kind: 'live', sequence: 1066, deletions: 0, backfill_window: null });
    expect(JSON.parse(String(rows[0]?.counts))).toMatchObject({ heart_rate: { 'com.fitbit.FitbitMobile': 3 } });
    expect(rows[1]).toEqual({
      kind: 'live',
      sequence: 1067,
      counts: '{}',
      deletions: 2,
      backfill_window: null,
      deletions_unavailable: '["nutrition"]',
      records_outside_window:
        '{"heart_rate":{"count":412,"from":"2026-09-14T06:02:11Z","until":"2026-09-16T05:33:02.112Z"}}',
    });
    expect(rows[2]).toMatchObject({
      kind: 'backfill',
      backfill_window: '{"start":"2026-06-25T09:14:58.120Z","end":"2026-06-28T09:14:58.120Z","complete":true}',
    });
  });
});

describe('write rules', () => {
  it('writes nothing for an unchanged re-send', async () => {
    await post(sync);
    const before = await budget();
    await post(sync);
    // Only the second ingest_log row, its index entry and its budget row.
    expect((await budget()) - before).toBe(3);
  });

  it('lets the newest read win and ignores a replayed older payload', async () => {
    await post(sync);
    const older = { ...withTimestamp(sync, '2026-09-23T05:00:00Z'), steps: [{ ...sync.steps[0], count: 999 }] };
    await post(older);
    expect(await all(`SELECT value FROM records WHERE type = 'steps' ORDER BY start_ms`)).toEqual([
      { value: 38 },
      { value: 112 },
    ]);
    const newer = { ...withTimestamp(sync, '2026-09-23T06:00:00Z'), steps: [{ ...sync.steps[0], count: 40 }] };
    await post(newer);
    expect(await all(`SELECT value FROM records WHERE type = 'steps' ORDER BY start_ms`)).toEqual([
      { value: 40 },
      { value: 112 },
    ]);
  });

  it('orders by payload timestamp, not sequence, so a reinstalled exporter starting again at 1 still wins', async () => {
    await post(sync);
    const reinstalled = {
      ...withTimestamp(sync, '2026-09-24T06:00:00Z'),
      sequence: 1,
      steps: [{ ...sync.steps[0], count: 41 }],
    };
    expect((await post(reinstalled)).status).toBe(200);
    expect(await all(`SELECT value FROM records WHERE type = 'steps' ORDER BY start_ms`)).toEqual([
      { value: 41 },
      { value: 112 },
    ]);
  });

  it('applies deletions before records, so a delete-and-rewrite in one payload keeps the record', async () => {
    await post(sync);
    const rewrite = {
      ...withTimestamp(sync, '2026-09-23T06:30:00Z'),
      deleted_records: [{ type: 'total_calories', uuid: KCAL }],
      total_calories: [{ ...sync.total_calories[0], calories: 1.31 }],
    };
    await post(rewrite);
    expect(await all(`SELECT value, deleted FROM records WHERE id = '${KCAL}'`)).toEqual([{ value: 1.31, deleted: 0 }]);
  });

  it('keeps a tombstone against an older payload and restores on a newer one', async () => {
    await post(sync);
    await post(deletions);
    expect(await all(`SELECT type, deleted FROM records WHERE id IN ('${KCAL}', '${HR}') ORDER BY type`)).toEqual([
      { type: 'heart_rate', deleted: 1 },
      { type: 'total_calories', deleted: 1 },
    ]);
    await post(sync);
    expect(await all(`SELECT deleted FROM records WHERE id = '${KCAL}'`)).toEqual([{ deleted: 1 }]);
    await post(withTimestamp(sync, '2026-09-23T07:00:00Z'));
    expect(await all(`SELECT deleted FROM records WHERE id = '${KCAL}'`)).toEqual([{ deleted: 0 }]);
  });

  it('ignores a deletion older than the stored record', async () => {
    await post(withTimestamp(sync, '2026-09-23T07:00:00Z'));
    await post(deletions);
    expect(await all(`SELECT deleted FROM records WHERE id = '${KCAL}'`)).toEqual([{ deleted: 0 }]);
  });

  it('writes a tombstone for a record it never saw', async () => {
    await post(deletions);
    expect(await all(`SELECT type, local_date, deleted FROM records ORDER BY type`)).toEqual([
      { type: 'heart_rate', local_date: '', deleted: 1 },
      { type: 'total_calories', local_date: '', deleted: 1 },
    ]);
    await post(sync);
    expect(await all(`SELECT deleted FROM records WHERE id = '${KCAL}'`)).toEqual([{ deleted: 1 }]);
  });

  it('moves a record whose attribution date changes and marks both dates dirty', async () => {
    await post(sync);
    await env.DB.exec('DELETE FROM dirty_days');
    const moved = {
      ...withTimestamp(sync, '2026-09-24T06:00:00Z'),
      steps: [{ ...sync.steps[0], start_time: '2026-09-24T05:31:00Z', end_time: '2026-09-24T05:32:00Z' }],
    };
    await post(moved);
    expect(await all(`SELECT local_date FROM records WHERE id = '${sync.steps[0]?.uuid}'`)).toEqual([
      { local_date: '2026-09-24' },
    ]);
    expect(await all('SELECT local_date FROM dirty_days ORDER BY local_date')).toEqual([
      { local_date: '2026-09-23' },
      { local_date: '2026-09-24' },
    ]);
    await cron();
    expect(await all(`SELECT local_date, value FROM daily WHERE metric = 'steps' ORDER BY local_date`)).toEqual([
      { local_date: '2026-09-23', value: 112 },
      { local_date: '2026-09-24', value: 38 },
    ]);
  });
});

describe('daily write budget', () => {
  it('refuses a backfill over 70,000 rows with 429 and Retry-After until 00:00 UTC', async () => {
    const now = Date.now();
    await env.DB.prepare('INSERT INTO write_budget (day, rows) VALUES (?1, 70001)').bind(utcDay(now)).run();
    const res = await post(backfill);
    expect(res.status).toBe(429);
    expect(Math.abs(Number(res.headers.get('Retry-After')) - secondsUntilUtcMidnight(now))).toBeLessThanOrEqual(2);
    expect((await post(sync)).status).toBe(200);
  });

  it('refuses a live payload over 90,000 rows', async () => {
    await env.DB.prepare('INSERT INTO write_budget (day, rows) VALUES (?1, 90001)').bind(utcDay(Date.now())).run();
    expect((await post(sync)).status).toBe(429);
    expect(await all(`SELECT status FROM ingest_log`)).toEqual([{ status: 429 }]);
  });
});

it('rolls back every record when the batch fails on its last statement', async () => {
  await env.DB.exec('DROP TABLE ingest_log');
  const res = await post(sync);
  expect(res.status).toBe(500);
  expect(await all('SELECT id FROM records')).toEqual([]);
});

it('answers 500 when D1 fails, so the exporter retries', async () => {
  await env.DB.exec('DROP TABLE records');
  const res = await post(sync);
  expect(res.status).toBe(500);
  expect(await all('SELECT status FROM ingest_log')).toEqual([{ status: 500 }]);
});
