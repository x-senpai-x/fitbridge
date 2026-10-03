import { describe, expect, it } from 'vitest';
import sync from './fixtures/ldc-payload-sync.composed.json';
import { callJson, callTool, mcp, ORIGIN, post } from './helpers';

describe('search and fetch', () => {
  it('lists all nine tools, all read-only', async () => {
    const client = await mcp();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'correlate',
      'fetch',
      'get_daily_summary',
      'get_intraday',
      'get_overview',
      'get_sleep',
      'get_trends',
      'get_workouts',
      'search',
    ]);
  });

  it('returns results with id, title and citation url', async () => {
    const client = await mcp();
    const answer = await callJson<{ results: { id: string; title: string; url: string }[] }>(client, 'search', {
      query: 'sleep 2026-09-23',
    });
    expect(answer.results[0]).toEqual({
      id: 'sleep:2026-09-23:2026-09-23',
      title: 'Sleep sessions 2026-09-23 to 2026-09-23',
      url: `${ORIGIN}/mcp#sleep:2026-09-23:2026-09-23`,
    });
  });

  it('fetches a document whose text is the same answer the tool gives', async () => {
    await post(sync);
    const client = await mcp();
    const doc = await callJson<{ id: string; title: string; text: string; url: string; metadata: object }>(
      client,
      'fetch',
      { id: 'sleep:2026-09-23:2026-09-23' },
    );
    const direct = await callTool(client, 'get_sleep', { start: '2026-09-23', end: '2026-09-23' });
    expect(doc.text).toBe(direct.text);
    expect(doc.metadata).toEqual({ kind: 'sleep', time_zone: 'Asia/Kolkata' });
  });

  it.each([
    ['search', { query: 'sleep 2026-09-23' }],
    ['fetch', { id: 'overview' }],
  ])('%s repeats its object as structuredContent and as one text item', async (name, args) => {
    const client = await mcp();
    const result = await client.callTool({ name, arguments: args });
    expect(result.content).toHaveLength(1);
    const block = result.content[0];
    if (block?.type !== 'text') throw new Error('no text block');
    expect(result.structuredContent).toEqual(JSON.parse(block.text));
  });

  it('refuses an impossible date in a fetch id with an error', async () => {
    const client = await mcp();
    const result = await callTool(client, 'fetch', { id: 'daily:2026-02-30:2026-03-05' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('2026-02-30');
  });

  it('states the id grammar in the overview document', async () => {
    const client = await mcp();
    const doc = await callJson<{ text: string }>(client, 'fetch', { id: 'overview' });
    expect(JSON.parse(doc.text).document_ids).toContain('trends:<metric>:<week|month|weekday>:<start>:<end>');
  });

  it('answers an unknown id with the grammar', async () => {
    const client = await mcp();
    const result = await callTool(client, 'fetch', { id: 'mood:today' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('unknown document id "mood:today"');
  });
});
