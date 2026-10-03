import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Json } from './payload';

export const ANSWER_LIMIT = 30_000;

export type Cell = string | number | boolean | null;
export type Table = {
  columns: string[];
  rows: Cell[][];
};
export type Answer = { [key: string]: Json; notes: string[] };

export class InputError extends Error {}

export function round(value: number | null, digits: number): number | null {
  if (value === null) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

export function checkRange(start: string, end: string, limit: number, limitLabel: string, fix: string): number {
  const days = daysBetween(start, end);
  if (days < 1) throw new InputError(`start ${start} is after end ${end}`);
  if (days > limit) throw new InputError(`range is ${days} days; the limit ${limitLabel} is ${limit}, ${fix}`);
  return days;
}

// One text block of compact JSON and no structuredContent copy, so the model reads the data once.
export function respond(produce: () => Promise<{ [key: string]: Json }>, narrow: string): Promise<CallToolResult> {
  return build(produce, narrow, false);
}

// ChatGPT's search and fetch contract wants the object as structuredContent and as the same JSON text.
export function respondStructured(
  produce: () => Promise<{ [key: string]: Json }>,
  narrow: string,
): Promise<CallToolResult> {
  return build(produce, narrow, true);
}

async function build(
  produce: () => Promise<{ [key: string]: Json }>,
  narrow: string,
  structured: boolean,
): Promise<CallToolResult> {
  let answer: { [key: string]: Json };
  try {
    answer = await produce();
  } catch (error) {
    if (error instanceof InputError) return { content: [{ type: 'text', text: error.message }], isError: true };
    throw error;
  }
  const text = JSON.stringify(answer);
  if (text.length > ANSWER_LIMIT) {
    return {
      content: [
        {
          type: 'text',
          text: `the answer would be ${text.length} characters; the limit is about ${ANSWER_LIMIT}. ${narrow}`,
        },
      ],
      isError: true,
    };
  }
  const content: CallToolResult['content'] = [{ type: 'text', text }];
  return structured ? { content, structuredContent: answer } : { content };
}
