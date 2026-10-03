import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import deletions from './fixtures/ldc-payload-deletions.composed.json';
import sync from './fixtures/ldc-payload-sync.composed.json';
import { callJson, callTool, cron, mcp, post, watchD1 } from './helpers';
import type { Table } from '../src/answer';
import { METRIC_NAMES } from '../src/metrics';
import { addDays } from '../src/time';

const FITBIT = 'com.fitbit.FitbitMobile';

describe('MCP server', () => {
  it('lists the retrieval tools, every tool read-only', async () => {
    const client = await mcp();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['get_daily_summary', 'get_overview']),
    );
    for (const tool of tools) expect(tool.annotations, tool.name).toEqual({ readOnlyHint: true, openWorldHint: false });
  });

  it('answers with exactly one text block and no structuredContent', async () => {
    await post(sync);
    const client = await mcp();
    const result = await callTool(client, 'get_daily_summary', { start: '2026-09-23', end: '2026-09-23' });
    expect(result).toMatchObject({ isError: false, blocks: 1, structured: false });
  });
});

describe('get_daily_summary', () => {
  it('returns one row per day with rounded values, local clock times and no zero-filling', async () => {
    await post(sync);
    const client = await mcp();
    const answer = await callJson<{ daily: Table; units: Record<string, string>; notes: string[] }>(
      client,
      'get_daily_summary',
      {
        start: '2026-09-21',
        end: '2026-09-24',
        metrics: [
          'steps',
          'hr_avg',
          'hrv_rmssd',
          'sleep_minutes',
          'sleep_efficiency',
          'bedtime',
          'wake_time',
          'resting_hr',
          'exercise_minutes',
        ],
      },
    );
    expect(answer.daily).toEqual({
      columns: [
        'date',
        'steps',
        'hr_avg',
        'hrv_rmssd',
        'sleep_minutes',
        'sleep_efficiency',
        'bedtime',
        'wake_time',
        'resting_hr',
        'exercise_minutes',
      ],
      rows: [
        ['2026-09-22', null, null, null, null, null, null, null, 56, 36],
        ['2026-09-23', 150, 63.3, 26.1, 393, 97.9, '03:31', '10:12', null, null],
      ],
    });
    expect(answer.units.hrv_rmssd).toBe('ms');
    expect(answer.notes.join(' ')).toContain('Asia/Kolkata');
    expect(answer.notes.join(' ')).toContain('can differ slightly from the single nightly number Google Health shows');
  });

  it('recomputes dirty days before reading, so it never waits for the cron', async () => {
    await post(sync);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM daily').first<{ n: number }>())?.n).toBe(0);
    const client = await mcp();
    const answer = await callJson<{ daily: Table }>(client, 'get_daily_summary', {
      start: '2026-09-23',
      end: '2026-09-23',
      metrics: ['steps'],
    });
    expect(answer.daily.rows).toEqual([['2026-09-23', 150]]);
  });

  it('names the dates it could not recompute within its bound', async () => {
    const dirty = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-05'];
    for (let i = 0; i < 14; i++) dirty.push(addDays('2026-07-10', i));
    await env.DB.batch(dirty.map((d) => env.DB.prepare('INSERT INTO dirty_days (local_date) VALUES (?1)').bind(d)));
    const client = await mcp();
    const answer = await callJson<{ notes: string[] }>(client, 'get_daily_summary', {
      start: '2026-07-01',
      end: '2026-07-31',
      metrics: ['steps'],
    });
    // The 14 newest dirty days are recomputed; the four oldest are still pending.
    expect(answer.notes).toContain(
      'Still being recomputed, so these dates may change: 2026-07-01 to 2026-07-03, 2026-07-05. Ask again in a few minutes for final numbers.',
    );
  });

  it('says no data for an empty range and gives coverage', async () => {
    await post(sync);
    await cron();
    const client = await mcp();
    const answer = await callJson<{ daily: Table; notes: string[]; coverage: object }>(client, 'get_daily_summary', {
      start: '2026-01-01',
      end: '2026-01-31',
      metrics: ['steps'],
    });
    expect(answer.daily.rows).toEqual([]);
    expect(answer.notes[0]).toBe('no data for these dates');
    expect(answer.coverage).toEqual({ first_date: '2026-09-23', last_date: '2026-09-23' });
  });

  it('refuses a reversed range and an impossible date with a message, not an empty answer', async () => {
    const client = await mcp();
    const reversed = await callTool(client, 'get_daily_summary', { start: '2026-09-30', end: '2026-09-01' });
    expect(reversed).toMatchObject({ isError: true, text: 'start 2026-09-30 is after end 2026-09-01' });
    const impossible = await callTool(client, 'get_daily_summary', { start: '2026-02-30', end: '2026-03-01' });
    expect(impossible.isError).toBe(true);
    expect(impossible.text).toBe('Input validation error: Invalid arguments for tool get_daily_summary: start: Invalid ISO date');
  });

  it('refuses a range too long for the metric count and says how to fix it', async () => {
    const client = await mcp();
    const metrics = [
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
    ];
    const result = await callTool(client, 'get_daily_summary', { start: '2025-01-01', end: '2026-06-04', metrics });
    expect(result).toMatchObject({
      isError: true,
      text: 'range is 520 days; the limit for 12 metrics is 366, pick fewer metrics or split it',
    });
  });

  it('refuses an answer over about 30,000 characters and says how to narrow it', async () => {
    const dates = Array.from({ length: 146 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
    await env.DB.batch(
      dates.flatMap((d) =>
        METRIC_NAMES.map((m) =>
          env.DB.prepare('INSERT INTO daily (local_date, metric, value) VALUES (?1, ?2, 123456.7)').bind(d, m),
        ),
      ),
    );
    const client = await mcp();
    const result = await callTool(client, 'get_daily_summary', { start: dates[0] ?? '', end: dates[145] ?? '' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(
      /^the answer would be \d+ characters; the limit is about 30000\. Pick fewer metrics, a shorter range, or use get_trends\.$/,
    );
  });
});

describe('get_overview', () => {
  it('reports coverage, sources, last ingest, data-quality warnings and what is never available', async () => {
    await post(sync);
    await post(deletions);
    const client = await mcp();
    const answer = await callJson<{
      time_zone: string;
      coverage: Table;
      sources: Table;
      warnings: Table;
      last_ingest: { received: string; age_minutes: number };
      writes_today: { rows: number };
      never_available: string[];
    }>(client, 'get_overview');
    expect(answer.time_zone).toBe('Asia/Kolkata');
    expect(answer.coverage.rows).toContainEqual(['steps', 'count', '2026-09-23', '2026-09-23', 1]);
    expect(answer.sources.rows).toContainEqual([FITBIT, 'heart_rate', 3, expect.any(String), expect.any(String)]);
    expect(answer.warnings.rows).toEqual([
      [
        'deletions_unavailable',
        'nutrition',
        expect.stringContaining('1 payload(s)'),
        '2026-09-23T06:03:40.118Z',
        '2026-09-23T06:03:40.118Z',
      ],
      [
        'records_outside_window',
        'heart_rate',
        expect.stringContaining('412 edited record(s)'),
        '2026-09-14T06:02:11Z',
        '2026-09-16T05:33:02.112Z',
      ],
    ]);
    expect(answer.writes_today.rows).toBeGreaterThan(0);
    expect(answer.never_available).toContain('Sleep Score');
  });

  it('reads a bounded number of rows however long the ingest log and the rejected records grow', async () => {
    await post(sync);
    await post({
      timestamp: '2026-09-23T07:00:00Z',
      app_version: '1.21.2',
      source: 'health_connect',
      hydration: Array.from({ length: 20 }, () => ({ liters: 0.5 })),
    });
    const day = 86_400_000;
    const old = Date.now() - 400 * day;
    const log = env.DB.prepare(
      `INSERT INTO ingest_log (received_ms, kind, payload_ms, bytes, counts, status) VALUES (?1, 'live', ?1, 100, '{"com.fitbit.FitbitMobile":{"steps":1}}', 200)`,
    );
    const reject = env.DB.prepare(
      `INSERT INTO rejected_records (received_ms, type, reason, raw) VALUES (?1, 'nutrition', 'unknown type', '{}')`,
    );
    const rows = Array.from({ length: 3000 }, (_, i) => [log.bind(old + i * 60_000), reject.bind(old + i * 60_000)]);
    for (let i = 0; i < rows.length; i += 250) await env.DB.batch(rows.slice(i, i + 250).flat());
    const spy = watchD1();
    const client = await mcp();
    const answer = await callJson<{ warnings: Table }>(client, 'get_overview');
    const rowsRead = await spy.rowsRead();
    vi.restoreAllMocks();
    expect(answer.warnings.rows.filter((r) => r[0] === 'rejected_records').map((r) => [r[1], r[2]])).toEqual([
      ['hydration', '20 record(s) refused: unknown type'],
    ]);
    // Measured 2026-10-03: 293 rows without the hydration rejects, plus 2 per reject received in the last 30 days.
    expect(rowsRead).toBeLessThan(400);
  });

  it('reads a constant number of reject rows however many arrived in the last 30 days', async () => {
    const now = Date.now();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 29999)
       INSERT INTO rejected_records (received_ms, type, reason, raw) SELECT ?1 - i * 60, 'heart_rate', 'bucketed series', '{}' FROM n`,
    )
      .bind(now)
      .run();
    const spy = watchD1();
    const client = await mcp();
    const answer = await callJson<{ warnings: Table; notes: string[] }>(client, 'get_overview');
    const rowsRead = await spy.rowsRead();
    vi.restoreAllMocks();
    expect(answer.warnings.rows.filter((r) => r[0] === 'rejected_records').map((r) => r[2])).toEqual([
      '10000 record(s) refused: bucketed series',
    ]);
    expect(answer.notes.some((n) => n.includes('newest 10,000 rejected records'))).toBe(true);
    // 30,000 rejects unbounded read about 60,000 rows; bounded, 2 per reject over 10,000 plus the fixed reads.
    expect(rowsRead).toBeLessThan(21_000);
  });

  it('groups rejected records of the last 30 days by type and reason without array indices, largest first', async () => {
    const stage = (start_time: string, end_time: string) => ({ stage: 'light', start_time, end_time });
    const session = (uuid: string, stages: object[]) => ({
      session_end_time: '2026-09-23T01:00:00Z',
      duration_seconds: 3600,
      uuid,
      source: FITBIT,
      stages,
    });
    const good = stage('2026-09-23T00:00:00Z', '2026-09-23T00:20:00Z');
    await post({
      timestamp: '2026-09-23T06:00:00Z',
      app_version: '1.21.2',
      source: 'health_connect',
      sleep: [
        session('a', [stage('soon', '2026-09-23T00:30:00Z')]),
        session('b', [good, good, stage('later', '2026-09-23T01:00:00Z')]),
      ],
      ...Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`type_${String(i).padStart(2, '0')}`, [{}]])),
    });
    const client = await mcp();
    const answer = await callJson<{ warnings: Table; notes: string[] }>(client, 'get_overview');
    const rejected = answer.warnings.rows.filter((r) => r[0] === 'rejected_records');
    expect(rejected).toHaveLength(20);
    expect(rejected[0]).toEqual([
      'rejected_records',
      'sleep',
      '2 record(s) refused: stages.start_time: Invalid ISO datetime',
      null,
      expect.any(String),
    ]);
    expect(rejected.slice(1).map((r) => r[1])).toEqual(
      Array.from({ length: 19 }, (_, i) => `type_${String(i).padStart(2, '0')}`),
    );
    expect(answer.notes).toContain('6 smaller group(s) of rejected records are not listed in warnings.');
  });

  it('fits its answer limit whatever the phone sent, also as the overview document', async () => {
    // Quotes double again when fetch("overview") carries the answer as an escaped string.
    const long = (i: number): string => `${'"'.repeat(3000)}${i}`;
    await post({
      timestamp: '2026-09-23T06:00:00Z',
      app_version: '1.21.2',
      source: 'health_connect',
      deletions_unavailable: Array.from({ length: 30 }, (_, i) => long(i)),
      steps: Array.from({ length: 30 }, (_, i) => ({
        count: 1,
        start_time: '2026-09-23T05:00:00Z',
        end_time: '2026-09-23T05:01:00Z',
        uuid: `steps-${i}`,
        source: long(i),
      })),
      ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [long(i), [{}]])),
    });
    // Every other day since 2000 still to recompute: too many separate dates to name them all.
    const dates = Array.from({ length: 3000 }, (_, i) => addDays('2000-01-01', 2 * i));
    await env.DB.prepare('INSERT INTO dirty_days (local_date) SELECT value FROM json_each(?1)')
      .bind(JSON.stringify(dates))
      .run();
    const client = await mcp();
    const direct = await callTool(client, 'get_overview', {});
    const doc = await callTool(client, 'fetch', { id: 'overview' });
    expect([direct.isError, doc.isError]).toEqual([false, false]);
    const { notes } = JSON.parse(direct.text) as { notes: string[] };
    expect(notes).toContainEqual(expect.stringMatching(/^\d+ source or warning row\(s\) are left out/));
    expect(notes).toContainEqual(expect.stringMatching(/, and \d+ later dates through 2016-\d\d-\d\d\. /));
  });
});
