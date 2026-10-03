import { z } from 'zod';
import { isoTime, isRecordType, type Reading, type RecordType, SCHEMAS } from './records';
import { type Clock, localDate } from './time';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const PACKED: ReadonlySet<RecordType> = new Set<RecordType>(['heart_rate', 'skin_temperature']);

const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'timestamp',
  'app_version',
  'source',
  'sequence',
  'backfill',
  'window_start',
  'window_end',
  'window_complete',
  'deleted_records',
  'deletions_unavailable',
  'records_outside_window',
  'daily_totals',
  '_diagnostics',
  '_resolutions',
  'writeback',
]);

export type Payload = { [key: string]: Json };

export const Envelope = z.object({
  timestamp: isoTime,
  app_version: z.string(),
  source: z.literal('health_connect'),
  sequence: z.number().int().optional(),
  backfill: z.boolean().optional(),
  window_start: isoTime.optional(),
  window_end: isoTime.optional(),
  window_complete: z.boolean().optional(),
  deleted_records: z.array(z.object({ type: z.string(), uuid: z.string().min(1) })).optional(),
  deletions_unavailable: z.array(z.string()).optional(),
  records_outside_window: z
    .record(z.string(), z.object({ count: z.number().int(), from: isoTime, until: isoTime }))
    .optional(),
});
export type Envelope = z.infer<typeof Envelope>;

export interface RecordRow {
  type: RecordType;
  id: string;
  source: string;
  start_ms: number;
  end_ms: number;
  local_date: string;
  value: number;
  n: number;
  vmin: number;
  vmax: number;
  body: string;
  minutes: string | null;
}

export interface Deletion {
  type: RecordType;
  id: string;
}

export interface Rejected {
  type: string;
  reason: string;
  raw: string;
}

export type Counts = Record<string, Record<string, number>>;

export interface Parsed {
  rows: RecordRow[];
  deletions: Deletion[];
  rejected: Rejected[];
  counts: Counts;
}

interface Pack {
  type: RecordType;
  id: string;
  source: string;
  samples: Map<number, number>;
}

export function recordId(uuid: string): string {
  const hash = uuid.indexOf('#');
  return hash === -1 ? uuid : uuid.slice(0, hash);
}

export function parsePayload(payload: Payload, envelope: Envelope, clock: Clock): Parsed {
  const rows: RecordRow[] = [];
  const rejected: Rejected[] = [];
  const counts: Counts = {};
  const packs = new Map<string, Pack>();
  for (const [key, value] of Object.entries(payload)) {
    if (ENVELOPE_KEYS.has(key)) continue;
    if (!isRecordType(key)) {
      const items = Array.isArray(value) ? value : [value];
      const reason = Array.isArray(value) ? 'unknown type' : 'unknown key';
      for (const item of items) rejected.push({ type: key, reason, raw: JSON.stringify(item) });
      continue;
    }
    if (!Array.isArray(value)) {
      rejected.push({ type: key, reason: 'expected an array of records', raw: JSON.stringify(value) });
      continue;
    }
    for (const item of value) {
      const result = SCHEMAS[key].safeParse(item);
      if (!result.success) {
        rejected.push({ type: key, reason: rejectReason(item, result.error), raw: JSON.stringify(item) });
        continue;
      }
      const reading = result.data;
      const bySource = counts[key] ?? (counts[key] = {});
      bySource[reading.source] = (bySource[reading.source] ?? 0) + 1;
      if (PACKED.has(key)) {
        addSample(packs, key, reading);
        continue;
      }
      // Sleep belongs to the date you wake up; everything else to its start.
      const attributedMs = key === 'sleep' ? reading.endMs : reading.startMs;
      rows.push({
        type: key,
        id: reading.uuid,
        source: reading.source,
        start_ms: reading.startMs,
        end_ms: reading.endMs,
        local_date: localDate(clock, attributedMs),
        value: reading.value,
        n: 1,
        vmin: reading.value,
        vmax: reading.value,
        body: reading.body,
        minutes: null,
      });
    }
  }
  for (const pack of packs.values()) rows.push(packedRow(pack, clock));
  const deletions = (envelope.deleted_records ?? []).flatMap((d) =>
    isRecordType(d.type) ? [{ type: d.type, id: recordId(d.uuid) }] : [],
  );
  return { rows, deletions, rejected, counts };
}

function addSample(packs: Map<string, Pack>, type: RecordType, reading: Reading): void {
  const id = recordId(reading.uuid);
  const key = `${type}#${id}`;
  let pack = packs.get(key);
  if (pack === undefined) {
    pack = { type, id, source: reading.source, samples: new Map() };
    packs.set(key, pack);
  }
  pack.samples.set(reading.startMs, reading.value);
}

function packedRow(pack: Pack, clock: Clock): RecordRow {
  const samples = [...pack.samples].sort((a, b) => a[0] - b[0]);
  const times = samples.map((s) => s[0]);
  const values = samples.map((s) => s[1]);
  const startMs = Math.min(...times);
  // UTC minutes equal local minutes in every zone with a whole-minute offset.
  const minutes: [number, number, number, number, number][] = [];
  for (const [ms, v] of samples) {
    const minute = Math.floor(ms / 60_000) * 60_000;
    const last = minutes.at(-1);
    if (last !== undefined && last[0] === minute) {
      last[1] += 1;
      last[2] += v;
      last[3] = Math.min(last[3], v);
      last[4] = Math.max(last[4], v);
    } else {
      minutes.push([minute, 1, v, v, v]);
    }
  }
  return {
    type: pack.type,
    id: pack.id,
    source: pack.source,
    start_ms: startMs,
    end_ms: Math.max(...times),
    local_date: localDate(clock, startMs),
    value: values.reduce((sum, v) => sum + v, 0) / values.length,
    n: values.length,
    vmin: Math.min(...values),
    vmax: Math.max(...values),
    body: JSON.stringify(samples),
    minutes: pack.type === 'heart_rate' ? JSON.stringify(minutes) : null,
  };
}

function rejectReason(item: Json, error: z.ZodError): string {
  if (typeof item === 'object' && item !== null && !Array.isArray(item) && 'bucket_start' in item) {
    return 'bucketed record: set this type to raw resolution in the exporter';
  }
  const issue = error.issues[0];
  if (issue === undefined) return 'invalid record';
  // Array indices are left out, so one defect groups as one reason in get_overview wherever it sits in a list.
  const path = issue.path.filter((key) => typeof key !== 'number').join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}
