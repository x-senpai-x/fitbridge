import { utcDay } from './time';

export const BACKFILL_LIMIT = 70_000;
export const LIVE_LIMIT = 90_000;

export async function writesToday(db: D1Database, now: number): Promise<number> {
  const row = await db
    .prepare('SELECT rows FROM write_budget WHERE day = ?1')
    .bind(utcDay(now))
    .first<{ rows: number }>();
  return row?.rows ?? 0;
}

export async function addWrites(db: D1Database, now: number, results: D1Result[]): Promise<void> {
  const written = results.reduce((sum, r) => sum + r.meta.rows_written, 0);
  if (written === 0) return;
  // The +1 is this statement's own write to write_budget.
  await db
    .prepare(
      'INSERT INTO write_budget (day, rows) VALUES (?1, ?2) ON CONFLICT (day) DO UPDATE SET rows = rows + excluded.rows',
    )
    .bind(utcDay(now), written + 1)
    .run();
}
