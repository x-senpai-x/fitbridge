import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const MOVE = `INSERT INTO records (type, id, source, start_ms, end_ms, local_date, value, n, vmin, vmax, body, observed_ms)
VALUES ('steps', 'a', 'com.fitbit.FitbitMobile', 0, 0, ?1, 1, 1, 1, 1, '{}', 1)
ON CONFLICT (type, id) DO UPDATE SET local_date = excluded.local_date`;

async function dirty(): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT local_date FROM dirty_days ORDER BY local_date').all<{
    local_date: string;
  }>();
  return rows.results.map((r) => r.local_date);
}

describe('scaffold', () => {
  it('answers /health', async () => {
    const res = await exports.default.fetch('https://fitbridge.test/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('creates the tables', async () => {
    const rows = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all<{ name: string }>();
    expect(rows.results.map((r) => r.name)).toEqual(
      expect.arrayContaining(['daily', 'dirty_days', 'ingest_log', 'rejected_records', 'records', 'write_budget']),
    );
  });
});

describe('dirty-day triggers', () => {
  it('marks the old and the new date when an upsert moves a record, even when one is already dirty', async () => {
    await env.DB.prepare(MOVE).bind('2026-09-22').run();
    expect(await dirty()).toEqual(['2026-09-22']);
    await env.DB.prepare(MOVE).bind('2026-09-23').run();
    expect(await dirty()).toEqual(['2026-09-22', '2026-09-23']);
  });

  it('marks the date of a deleted row and ignores rows without a date', async () => {
    await env.DB.prepare(MOVE).bind('').run();
    expect(await dirty()).toEqual([]);
    await env.DB.prepare(MOVE).bind('2026-09-24').run();
    await env.DB.exec('DELETE FROM dirty_days');
    await env.DB.exec(`DELETE FROM records WHERE id = 'a'`);
    expect(await dirty()).toEqual(['2026-09-24']);
  });
});
