import { addWrites, BACKFILL_LIMIT, LIVE_LIMIT, writesToday } from './budget';
import { verifySignature } from './hmac';
import { type Deletion, Envelope, type Json, parsePayload, type RecordRow, type Rejected } from './payload';
import { clockFor, secondsUntilUtcMidnight } from './time';

const MAX_BODY_BYTES = 10 * 1024 * 1024;
// Each chunk is one bound JSON parameter; 500 records stay well under D1's 2 MB value limit.
const CHUNK = 500;

const DELETE_SQL = `INSERT INTO records (type, id, source, start_ms, end_ms, local_date, value, n, vmin, vmax, body, observed_ms, deleted)
SELECT j.value ->> 'type', j.value ->> 'id', '', 0, 0, '', NULL, 0, NULL, NULL, '', ?2, 1
FROM json_each(?1) AS j WHERE true
ON CONFLICT (type, id) DO UPDATE SET deleted = 1, observed_ms = excluded.observed_ms
WHERE excluded.observed_ms >= records.observed_ms
  AND NOT (records.deleted = 1 AND records.observed_ms = excluded.observed_ms)`;

const UPSERT_SQL = `INSERT INTO records (type, id, source, start_ms, end_ms, local_date, value, n, vmin, vmax, body, minutes, observed_ms, deleted)
SELECT j.value ->> 'type', j.value ->> 'id', j.value ->> 'source', j.value ->> 'start_ms', j.value ->> 'end_ms',
       j.value ->> 'local_date', j.value ->> 'value', j.value ->> 'n', j.value ->> 'vmin', j.value ->> 'vmax',
       j.value ->> 'body', j.value ->> 'minutes', ?2, 0
FROM json_each(?1) AS j WHERE true
ON CONFLICT (type, id) DO UPDATE SET
  source = excluded.source, start_ms = excluded.start_ms, end_ms = excluded.end_ms, local_date = excluded.local_date,
  value = excluded.value, n = excluded.n, vmin = excluded.vmin, vmax = excluded.vmax, body = excluded.body,
  minutes = excluded.minutes, observed_ms = excluded.observed_ms, deleted = 0
WHERE excluded.observed_ms >= records.observed_ms
  AND (records.deleted = 1 OR records.body <> excluded.body OR records.source <> excluded.source
       OR records.local_date <> excluded.local_date)`;

const REJECT_SQL = `INSERT INTO rejected_records (received_ms, payload_ms, type, reason, raw)
SELECT ?2, ?3, j.value ->> 'type', j.value ->> 'reason', j.value ->> 'raw' FROM json_each(?1) AS j`;

const LOG_SQL = `INSERT INTO ingest_log (received_ms, kind, payload_ms, sequence, bytes, counts, deletions, backfill_window,
  deletions_unavailable, records_outside_window, status, error)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`;

interface LogEntry {
  received: number;
  kind: 'live' | 'backfill' | 'test' | 'invalid';
  payloadMs: number | null;
  sequence: number | null;
  bytes: number;
  counts: string;
  deletions: number;
  backfillWindow: string | null;
  deletionsUnavailable: string | null;
  recordsOutsideWindow: string | null;
  status: number;
  error: string | null;
}

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('method not allowed\n', { status: 405, headers: { Allow: 'POST' } });
  }
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > MAX_BODY_BYTES) return tooLarge(declared);
  const reader = request.body?.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        return tooLarge(length);
      }
      parts.push(value);
    }
  }
  const packed = new Uint8Array(length);
  let offset = 0;
  for (const chunk of parts) { packed.set(chunk, offset); offset += chunk.byteLength; }
  const body = packed.buffer;
  if (!env.INGEST_SECRET) return new Response('Finish owner setup before syncing the phone.\n', { status: 409 });
  if (!(await verifySignature(env.INGEST_SECRET, body, request.headers.get('X-Signature')))) {
    // Not written to D1: an unauthenticated caller must not be able to spend the daily write budget.
    console.log(JSON.stringify({ ingest: 401, bytes: body.byteLength }));
    return new Response('bad signature\n', { status: 401 });
  }
  const received = Date.now();
  const bytes = body.byteLength;
  let payload: Json;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return refuse(env, received, bytes, 'body is not JSON');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return refuse(env, received, bytes, 'body is not a JSON object');
  }
  if (payload.test === true) {
    await log(env, entry(received, 'test', bytes, 200, null));
    return Response.json({ status: 'ok', test: true });
  }
  const envelope = Envelope.safeParse(payload);
  if (!envelope.success) {
    return refuse(env, received, bytes, `invalid envelope: ${envelope.error.issues[0]?.message ?? ''}`);
  }
  const head = envelope.data;
  const kind = head.backfill === true ? 'backfill' : 'live';
  const limit = kind === 'backfill' ? BACKFILL_LIMIT : LIVE_LIMIT;
  const written = await writesToday(env.DB, received);
  if (written > limit) {
    const retryAfter = secondsUntilUtcMidnight(received);
    await log(env, {
      ...entry(received, kind, bytes, 429, `daily write budget: ${written} rows written today, limit ${limit}`),
      payloadMs: Date.parse(head.timestamp),
    });
    return new Response(`daily write budget used; retry after ${retryAfter} s\n`, {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    });
  }
  const payloadMs = Date.parse(head.timestamp);
  if (env.AUTH_MODE !== 'google') {
    const locked = await env.DB.prepare(`UPDATE owner SET ingest_started = 1 WHERE id = 1 AND ingest_started = 0
      AND timezone = ?1 AND ingest_secret = ?2 RETURNING id`).bind(env.TIMEZONE, env.INGEST_SECRET).all();
    await addWrites(env.DB, received, [locked]);
    const current = locked.results.length || await env.DB.withSession('first-primary').prepare(`SELECT id FROM owner
      WHERE id = 1 AND ingest_started = 1 AND timezone = ?1 AND ingest_secret = ?2`).bind(env.TIMEZONE, env.INGEST_SECRET).first();
    if (!current) return new Response('Owner settings changed during sync. Retry with the current pairing key.\n', { status: 409 });
  }
  const parsed = parsePayload(payload, head, clockFor(env.TIMEZONE));
  const statements = [
    ...chunks(parsed.deletions).map((c) => env.DB.prepare(DELETE_SQL).bind(JSON.stringify(c), payloadMs)),
    ...chunks(parsed.rows).map((c) => env.DB.prepare(UPSERT_SQL).bind(JSON.stringify(c), payloadMs)),
    ...chunks(parsed.rejected).map((c) => env.DB.prepare(REJECT_SQL).bind(JSON.stringify(c), received, payloadMs)),
    logStatement(env, {
      received,
      kind,
      payloadMs,
      sequence: head.sequence ?? null,
      bytes,
      counts: JSON.stringify(parsed.counts),
      deletions: head.deleted_records?.length ?? 0,
      backfillWindow:
        kind === 'backfill'
          ? JSON.stringify({
              start: head.window_start ?? null,
              end: head.window_end ?? null,
              complete: head.window_complete ?? null,
            })
          : null,
      deletionsUnavailable:
        head.deletions_unavailable === undefined ? null : JSON.stringify(head.deletions_unavailable),
      recordsOutsideWindow:
        head.records_outside_window === undefined ? null : JSON.stringify(head.records_outside_window),
      status: 200,
      error: null,
    }),
  ];
  let results: D1Result[];
  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    console.error(JSON.stringify({ ingest: 500, error: 'storage_error' }));
    await log(env, { ...entry(received, kind, bytes, 500, 'storage_error'), payloadMs }).catch(() => undefined);
    return new Response('storage error; retry later\n', { status: 500 });
  }
  await addWrites(env.DB, received, results);
  return Response.json({
    status: 'ok',
    records: parsed.rows.length,
    deletions: parsed.deletions.length,
    rejected: parsed.rejected.length,
  });
}

function chunks<T extends RecordRow | Deletion | Rejected>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

function tooLarge(bytes: number): Response {
  console.log(JSON.stringify({ ingest: 413, bytes }));
  return new Response(`body is ${bytes} bytes; the limit is ${MAX_BODY_BYTES}\n`, { status: 413 });
}

async function refuse(env: Env, received: number, bytes: number, reason: string): Promise<Response> {
  await log(env, entry(received, 'invalid', bytes, 400, reason));
  return new Response(`${reason}\n`, { status: 400 });
}

function entry(
  received: number,
  kind: LogEntry['kind'],
  bytes: number,
  status: number,
  error: string | null,
): LogEntry {
  return {
    received,
    kind,
    payloadMs: null,
    sequence: null,
    bytes,
    counts: '{}',
    deletions: 0,
    backfillWindow: null,
    deletionsUnavailable: null,
    recordsOutsideWindow: null,
    status,
    error,
  };
}

function logStatement(env: Env, e: LogEntry): D1PreparedStatement {
  return env.DB.prepare(LOG_SQL).bind(
    e.received,
    e.kind,
    e.payloadMs,
    e.sequence,
    e.bytes,
    e.counts,
    e.deletions,
    e.backfillWindow,
    e.deletionsUnavailable,
    e.recordsOutsideWindow,
    e.status,
    e.error,
  );
}

async function log(env: Env, e: LogEntry): Promise<void> {
  const result = await logStatement(env, e).run();
  await addWrites(env.DB, e.received, [result]);
}
