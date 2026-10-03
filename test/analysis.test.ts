import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Table } from '../src/answer';
import { addDays } from '../src/time';
import { callJson, callTool, mcp } from './helpers';

// Fourteen days from Monday 2026-09-07: steps 1000, 2000, ... 14000; hrv 30 + day, missing on 2026-09-10.
beforeEach(async () => {
  const statements = [];
  for (let i = 0; i < 14; i++) {
    const date = addDays('2026-09-07', i);
    statements.push(
      env.DB.prepare(`INSERT INTO daily (local_date, metric, value) VALUES (?1, 'steps', ?2)`).bind(
        date,
        1000 * (i + 1),
      ),
    );
    if (date !== '2026-09-10')
      statements.push(
        env.DB.prepare(`INSERT INTO daily (local_date, metric, value) VALUES (?1, 'hrv_rmssd', ?2)`).bind(date, 30 + i),
      );
  }
  // 23:00 and 00:30 local bedtimes in Asia/Kolkata.
  statements.push(
    env.DB.prepare(`INSERT INTO daily VALUES ('2026-09-07', 'bedtime', ?1)`).bind(Date.parse('2026-09-06T17:30:00Z')),
  );
  statements.push(
    env.DB.prepare(`INSERT INTO daily VALUES ('2026-09-08', 'bedtime', ?1)`).bind(Date.parse('2026-09-07T19:00:00Z')),
  );
  await env.DB.batch(statements);
});

describe('get_trends', () => {
  it('gives exact weekly statistics and the slope per week', async () => {
    const client = await mcp();
    const answer = await callJson<{ groups: Table; trend: Table }>(client, 'get_trends', {
      metrics: ['steps'],
      start: '2026-09-07',
      end: '2026-09-20',
      group_by: 'week',
    });
    expect(answer.groups.rows).toEqual([
      ['steps', '2026-09-07', 7, 4000, 4000, 2160.2, 1000, 7000],
      ['steps', '2026-09-14', 7, 11000, 11000, 2160.2, 8000, 14000],
    ]);
    expect(answer.trend.rows).toEqual([['steps', 7000, 14, '2026-09-07', '2026-09-20']]);
  });

  it('groups by weekday in Monday-first order and turns bedtime into minutes from midnight', async () => {
    const client = await mcp();
    const answer = await callJson<{ groups: Table; notes: string[] }>(client, 'get_trends', {
      metrics: ['steps', 'bedtime'],
      start: '2026-09-07',
      end: '2026-09-20',
      group_by: 'weekday',
    });
    expect(answer.groups.rows.slice(0, 2)).toEqual([
      ['steps', 'Mon', 2, 4500, 4500, 4949.7, 1000, 8000],
      ['steps', 'Tue', 2, 5500, 5500, 4949.7, 2000, 9000],
    ]);
    expect(answer.groups.rows.filter((r) => r[0] === 'bedtime')).toEqual([
      ['bedtime', 'Mon', 1, -60, -60, null, -60, -60],
      ['bedtime', 'Tue', 1, 30, 30, null, 30, 30],
    ]);
    expect(answer.notes.join(' ')).toContain('negative before it');
  });

  it('answers an empty range with the coverage of the metrics', async () => {
    const client = await mcp();
    const answer = await callJson<{ groups: Table; notes: string[]; coverage: { first_date: string; last_date: string } }>(
      client,
      'get_trends',
      { metrics: ['steps'], start: '2020-01-01', end: '2020-01-31', group_by: 'week' },
    );
    expect(answer.groups.rows).toEqual([]);
    expect(answer.notes[0]).toBe('no data for these dates');
    expect(answer.coverage).toEqual({ first_date: '2026-09-07', last_date: '2026-09-20' });
  });

  it('refuses too many group rows and says how to narrow', async () => {
    const client = await mcp();
    const result = await callTool(client, 'get_trends', {
      metrics: ['steps', 'hr_avg', 'hrv_rmssd', 'sleep_minutes', 'resting_hr'],
      start: '2024-01-01',
      end: '2026-09-30',
      group_by: 'week',
    });
    expect(result).toMatchObject({
      isError: true,
      text: '720 group rows; the limit is 300, pick fewer metrics or group by month',
    });
  });
});

describe('correlate', () => {
  it('pairs the same date and leaves out missing days', async () => {
    const client = await mcp();
    const answer = await callJson<{ n: number; pearson_r: number; spearman_rho: number; pairs: Table }>(
      client,
      'correlate',
      {
        metric_x: 'steps',
        metric_y: 'hrv_rmssd',
        start: '2026-09-07',
        end: '2026-09-20',
      },
    );
    expect(answer).toMatchObject({ n: 13, pearson_r: 1, spearman_rho: 1 });
    expect(answer.pairs.columns).toEqual(['date_x', 'date_y', 'steps', 'hrv_rmssd']);
    expect(answer.pairs.rows[0]).toEqual(['2026-09-07', '2026-09-07', 1000, 30]);
  });

  it('lags y after x', async () => {
    const client = await mcp();
    const answer = await callJson<{ n: number; pairs: Table }>(client, 'correlate', {
      metric_x: 'steps',
      metric_y: 'hrv_rmssd',
      start: '2026-09-07',
      end: '2026-09-20',
      lag_days: 1,
    });
    expect(answer.n).toBe(12);
    expect(answer.pairs.rows[0]).toEqual(['2026-09-07', '2026-09-08', 1000, 31]);
  });

  it('answers an empty range with the coverage and the series without data', async () => {
    const client = await mcp();
    const answer = await callJson<{
      n: number;
      notes: string[];
      coverage: { first_date: string; last_date: string };
    }>(client, 'correlate', {
      metric_x: 'steps',
      metric_y: 'sleep_minutes',
      start: '2026-09-07',
      end: '2026-09-20',
    });
    expect(answer.n).toBe(0);
    expect(answer.notes[0]).toBe('no data for these dates');
    expect(answer.notes.join(' ')).toContain('no data for sleep_minutes');
    expect(answer.notes.join(' ')).not.toContain('no data for steps');
    expect(answer.coverage).toEqual({ first_date: '2026-09-07', last_date: '2026-09-20' });
  });

  it('refuses a lag over 7 days', async () => {
    const client = await mcp();
    const result = await callTool(client, 'correlate', {
      metric_x: 'steps',
      metric_y: 'hrv_rmssd',
      start: '2026-09-07',
      end: '2026-09-20',
      lag_days: 8,
    });
    expect(result.isError).toBe(true);
  });
});
