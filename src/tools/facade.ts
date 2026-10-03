import type { Answer } from '../answer';
import { type Doc, docId, docTitle, ID_GRAMMAR, parseId, search } from '../search';
import { clockFor, localDate } from '../time';
import { correlate } from './correlate';
import { dailySummary } from './daily-summary';
import { finestFit, intraday } from './intraday';
import { overview } from './overview';
import { sleep } from './sleep';
import { trends } from './trends';
import { workouts } from './workouts';

export type SearchAnswer = { results: { id: string; title: string; url: string }[] };
export type FetchAnswer = {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata: { kind: string; time_zone: string };
};

// Citations need a URL; the MCP endpoint is the only resource this server publishes.
const citation = (origin: string, id: string): string => `${origin}/mcp#${id}`;

export function searchDocs(env: Env, query: string, origin: string): SearchAnswer {
  const clock = clockFor(env.TIMEZONE);
  const docs = search(query, localDate(clock, Date.now()), clock);
  return { results: docs.map((doc) => ({ id: docId(doc), title: docTitle(doc), url: citation(origin, docId(doc)) })) };
}

export async function fetchDoc(env: Env, id: string, origin: string): Promise<FetchAnswer> {
  const doc = parseId(id);
  const answer = await render(env, doc);
  return {
    id,
    title: docTitle(doc),
    text: JSON.stringify(answer),
    url: citation(origin, id),
    metadata: { kind: doc.kind, time_zone: env.TIMEZONE },
  };
}

async function render(env: Env, doc: Doc): Promise<Answer> {
  switch (doc.kind) {
    case 'overview':
      return { ...(await overview(env)), document_ids: ID_GRAMMAR };
    case 'daily':
      return dailySummary(env, doc.start, doc.end);
    case 'sleep':
      return sleep(env, doc.start, doc.end, 'summary');
    case 'workouts':
      return workouts(env, doc.start, doc.end);
    case 'intraday':
      return intraday(env, doc.metric, doc.start, doc.end, finestFit(Date.parse(doc.end) - Date.parse(doc.start)));
    case 'trends':
      return trends(env, [doc.metric], doc.start, doc.end, doc.group);
    case 'correlate':
      return correlate(env, doc.x, doc.y, doc.start, doc.end, doc.lag);
  }
}
