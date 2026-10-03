import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { recomputeDirty } from '../src/daily';
import { post } from './helpers';
import { syntheticDataset } from './synthetic';

it(
  'derives 14 synthetic days at Fitbit density exactly as the reference computes them',
  { timeout: 120_000 },
  async () => {
    const t0 = Date.now();
    const { payloads, days } = syntheticDataset('2026-09-01', 14, 1990);
    console.log('payloads', payloads.length);
    let refused = 0;
    for (const payload of payloads) {
      let res = await post(payload);
      if (res.status === 429) {
        refused += 1;
        // Simulate 00:00 UTC: the exporter's outbox resends the same payload the next day.
        await env.DB.exec('DELETE FROM write_budget');
        res = await post(payload);
      }
      expect(res.status).toBe(200);
    }
    console.log('refused', refused);
    const t1 = Date.now();
    // 15 dirty days (the 14 and the evening before the first) take two bounded runs, as two cron runs would.
    expect(await recomputeDirty(env)).toHaveLength(1);
    expect(await recomputeDirty(env)).toEqual([]);
    const t2 = Date.now();
    console.log('ingest ms', t1 - t0, 'recompute ms', t2 - t1);
    for (const day of days) {
      const rows = await env.DB.prepare('SELECT metric, value FROM daily WHERE local_date = ?1')
        .bind(day.date)
        .all<{ metric: string; value: number }>();
      const actual = Object.fromEntries(rows.results.map((r) => [r.metric, r.value]));
      expect(Object.keys(actual).sort()).toEqual(Object.keys(day.expected).sort());
      for (const [metric, value] of Object.entries(day.expected))
        expect(actual[metric], `${day.date} ${metric}`).toBeCloseTo(value, 6);
    }
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM records').first<{ n: number }>();
    const budget = await env.DB.prepare('SELECT SUM(rows) AS n FROM write_budget').first<{ n: number }>();
    console.log('records', count?.n, 'budget', budget?.n, 'per day', (budget?.n ?? 0) / 14);
  },
);
