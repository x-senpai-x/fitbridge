import { ANSWER_LIMIT, type Answer, type Cell, round, type Table } from '../answer';
import { BACKFILL_LIMIT, LIVE_LIMIT, writesToday } from '../budget';
import { birthYear, recomputeDirty, staleNote } from '../daily';
import { type DailyMetric, METRIC_INFO } from '../metrics';

const WINDOW_DAYS = 30;
const REJECTED_GROUPS = 20;
const REJECTED_SCANNED = 10_000;
// fetch("overview") sends this answer as an escaped JSON string, up to twice as long, plus the id grammar.
const OVERVIEW_LIMIT = ANSWER_LIMIT / 2 - 1_000;
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const leftOut = (rows: number): string =>
  `${rows} source or warning row(s) are left out so this answer stays under ${OVERVIEW_LIMIT} characters.`;

export async function overview(env: Env): Promise<Answer> {
  const stale = await recomputeDirty(env);
  const now = Date.now();
  const db = env.DB;
  const since = now - WINDOW_DAYS * 86_400_000;
  const [coverage, last, sources, unavailable, outside, rejected, written] = await Promise.all([
    db
      .prepare(
        'SELECT metric, MIN(local_date) AS first, MAX(local_date) AS last, COUNT(*) AS days FROM daily GROUP BY metric ORDER BY metric',
      )
      .all<{ metric: DailyMetric; first: string; last: string; days: number }>(),
    db
      .prepare(
        `SELECT received_ms AS ms FROM ingest_log WHERE status = 200 AND kind IN ('live', 'backfill') ORDER BY received_ms DESC LIMIT 1`,
      )
      .all<{ ms: number }>(),
    db
      .prepare(
        `SELECT s.key AS source, t.key AS type, SUM(s.value) AS records, MIN(l.received_ms) AS first_ms, MAX(l.received_ms) AS last_ms
         FROM ingest_log AS l JOIN json_each(l.counts) AS t JOIN json_each(t.value) AS s
         WHERE l.received_ms >= ?1 GROUP BY s.key, t.key ORDER BY s.key, t.key`,
      )
      .bind(since)
      .all<{ source: string; type: string; records: number; first_ms: number; last_ms: number }>(),
    db
      .prepare(
        `SELECT u.value AS type, COUNT(*) AS payloads, MIN(l.payload_ms) AS first_ms, MAX(l.payload_ms) AS last_ms
         FROM ingest_log AS l JOIN json_each(l.deletions_unavailable) AS u WHERE l.received_ms >= ?1 GROUP BY u.value ORDER BY u.value`,
      )
      .bind(since)
      .all<{ type: string; payloads: number; first_ms: number; last_ms: number }>(),
    db
      .prepare(
        `SELECT o.key AS type, SUM(o.value ->> 'count') AS records, MIN(o.value ->> 'from') AS first, MAX(o.value ->> 'until') AS last
         FROM ingest_log AS l JOIN json_each(l.records_outside_window) AS o WHERE l.received_ms >= ?1 GROUP BY o.key ORDER BY o.key`,
      )
      .bind(since)
      .all<{ type: string; records: number; first: string; last: string }>(),
    db
      .prepare(
        `SELECT type, reason, COUNT(*) AS records, MAX(received_ms) AS last_ms, COUNT(*) OVER () AS groups,
                SUM(COUNT(*)) OVER () AS scanned
         FROM (SELECT type, reason, received_ms FROM rejected_records WHERE received_ms >= ?1 ORDER BY received_ms DESC LIMIT ?3)
         GROUP BY type, reason ORDER BY records DESC, type, reason LIMIT ?2`,
      )
      .bind(since, REJECTED_GROUPS, REJECTED_SCANNED)
      .all<{ type: string; reason: string; records: number; last_ms: number; groups: number; scanned: number }>(),
    writesToday(db, now),
  ]);
  const lastMs = last.results[0]?.ms ?? null;
  const warningRows: Cell[][] = [
    ...unavailable.results.map((r) => [
      'deletions_unavailable',
      r.type,
      `deletions of this type could not be observed in ${r.payloads} payload(s); records deleted on the phone may still be stored`,
      iso(r.first_ms),
      iso(r.last_ms),
    ]),
    ...outside.results.map((r) => [
      'records_outside_window',
      r.type,
      `${r.records} edited record(s) fell before the exporter's read window, so they are missing or stale here`,
      r.first,
      r.last,
    ]),
    ...rejected.results.map((r) => [
      'rejected_records',
      r.type,
      `${r.records} record(s) refused: ${r.reason}`,
      null,
      iso(r.last_ms),
    ]),
  ];
  const sourceRows: Cell[][] = sources.results.map((r) => [
    r.source,
    r.type,
    r.records,
    iso(r.first_ms),
    iso(r.last_ms),
  ]);
  const notes = [
    `Time zone: ${env.TIMEZONE}. Dates are local dates; data recorded while travelling is attributed in this zone.`,
    `Daily figures use records from ${env.PRIMARY_SOURCE} only; other sources are stored and listed under sources.`,
    'Use get_daily_summary for daily numbers, get_sleep for sessions and stages, get_workouts for exercise with heart-rate zones, get_intraday for up to 48 hours of samples, get_trends for weekly, monthly or weekday statistics, and correlate for the relation between two metrics.',
    `sources and warnings cover the last ${WINDOW_DAYS} days of received payloads; rejected records are grouped by type and reason, the ${REJECTED_GROUPS} largest groups first.`,
    'To repair a data-quality warning, purge that type and date range (see the runbook), then run the exporter backfill for it.',
  ];
  const unlisted = (rejected.results[0]?.groups ?? 0) - rejected.results.length;
  if (unlisted > 0) notes.push(`${unlisted} smaller group(s) of rejected records are not listed in warnings.`);
  if ((rejected.results[0]?.scanned ?? 0) >= REJECTED_SCANNED)
    notes.push(`The rejected-records warning is based on the newest ${REJECTED_SCANNED.toLocaleString('en-US')} rejected records only.`);
  if (birthYear(env) === null) notes.push('BIRTH_YEAR is not set, so azm and heart-rate zones are absent.');
  if (stale.length > 0) notes.push(staleNote(stale));
  const sourceTable: Table = {
    columns: ['source', 'type', 'records_received', 'first_received', 'last_received'],
    rows: [],
  };
  const warningTable: Table = { columns: ['kind', 'type', 'detail', 'from', 'until'], rows: [] };
  const answer: Answer = {
    time_zone: env.TIMEZONE,
    primary_source: env.PRIMARY_SOURCE,
    last_ingest: lastMs === null ? null : { received: iso(lastMs), age_minutes: round((now - lastMs) / 60_000, 0) },
    writes_today: { rows: written, backfill_limit: BACKFILL_LIMIT, live_limit: LIVE_LIMIT },
    coverage: {
      columns: ['metric', 'unit', 'first_date', 'last_date', 'days'],
      rows: coverage.results.map((r) => [r.metric, METRIC_INFO[r.metric].unit, r.first, r.last, r.days]),
    },
    sources: sourceTable,
    warnings: warningTable,
    never_available: [
      'Daily Readiness',
      'Sleep Score',
      'Cardio Load',
      'stress',
      "Fitbit's own Active Zone Minutes (azm here is an estimate from heart-rate samples)",
    ],
    notes,
  };
  // What the phone sent decides how many source and warning rows there are, so the ones that do not fit are left out.
  const noteRoom = JSON.stringify(leftOut(warningRows.length + sourceRows.length)).length + 1;
  let room = OVERVIEW_LIMIT - JSON.stringify(answer).length - noteRoom;
  let left = 0;
  const fills: [Table, Cell[][]][] = [
    [warningTable, warningRows],
    [sourceTable, sourceRows],
  ];
  for (const [table, rows] of fills) {
    for (const row of rows) {
      const size = JSON.stringify(row).length + 1;
      if (size > room) {
        left += 1;
      } else {
        table.rows.push(row);
        room -= size;
      }
    }
  }
  if (left > 0) notes.push(leftOut(left));
  return answer;
}
