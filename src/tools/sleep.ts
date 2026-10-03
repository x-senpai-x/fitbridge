import { z } from 'zod';
import { type Answer, type Cell, checkRange, round } from '../answer';
import { MAIN_SLEEP_ORDER, STAGE_MINUTES, recomputeDirty, stageCounters, staleNote } from '../daily';
import { coverage } from './daily-summary';
import { clockFor, localClock, localDateTime } from '../time';

export const SUMMARY_DAYS = 120;
export const STAGES_DAYS = 14;

const SleepBody = z.object({
  stages: z.array(z.object({ stage: z.string(), start_time: z.string(), end_time: z.string() })),
});

interface Session {
  d: string;
  start_ms: number;
  end_ms: number;
  main: number;
  body: string;
  known: number;
  asleep_staged: number;
  granular: number;
  asleep: number;
  awake: number;
  light: number;
  deep: number;
  rem: number;
}

export async function sleep(env: Env, start: string, end: string, detail: 'summary' | 'stages'): Promise<Answer> {
  if (detail === 'stages') {
    checkRange(start, end, STAGES_DAYS, 'with detail stages', 'shorten it or use detail summary');
  } else {
    checkRange(start, end, SUMMARY_DAYS, 'for sleep sessions', 'split it or use get_trends');
  }
  const stale = await recomputeDirty(env, { start, end });
  const sessions = await env.DB.prepare(
    `WITH ranked AS (
       SELECT local_date AS d, id, start_ms, end_ms, body,
              ROW_NUMBER() OVER (PARTITION BY local_date ORDER BY ${MAIN_SLEEP_ORDER}) AS rn
       FROM records WHERE type = 'sleep' AND local_date BETWEEN ?1 AND ?2 AND deleted = 0 AND source = ?3
     )
     SELECT ranked.d, ranked.start_ms, ranked.end_ms, ranked.rn = 1 AS main, ranked.body,
            ${stageCounters("s.value ->> 'stage'")},
            TOTAL(CASE WHEN s.value ->> 'stage' IN ('light', 'deep', 'rem', 'sleeping') THEN ${STAGE_MINUTES} END) AS asleep,
            TOTAL(CASE WHEN s.value ->> 'stage' IN ('awake', 'awake_in_bed', 'out_of_bed') THEN ${STAGE_MINUTES} END) AS awake,
            TOTAL(CASE WHEN s.value ->> 'stage' = 'light' THEN ${STAGE_MINUTES} END) AS light,
            TOTAL(CASE WHEN s.value ->> 'stage' = 'deep' THEN ${STAGE_MINUTES} END) AS deep,
            TOTAL(CASE WHEN s.value ->> 'stage' = 'rem' THEN ${STAGE_MINUTES} END) AS rem
     FROM ranked LEFT JOIN json_each(ranked.body, '$.stages') AS s
     GROUP BY ranked.d, ranked.id ORDER BY ranked.start_ms`,
  )
    .bind(start, end, env.PRIMARY_SOURCE)
    .all<Session>();
  const clock = clockFor(env.TIMEZONE);
  const measured = (count: number, minutes: number): number | null => (count > 0 ? round(minutes, 0) : null);
  const rows: Cell[][] = sessions.results.map((s) => {
    const inBed = (s.end_ms - s.start_ms) / 60_000;
    return [
      s.d,
      localDateTime(clock, s.start_ms),
      localDateTime(clock, s.end_ms),
      s.main === 1,
      round(inBed, 0),
      measured(s.asleep_staged, s.asleep),
      measured(s.known, s.awake),
      measured(s.granular, s.light),
      measured(s.granular, s.deep),
      measured(s.granular, s.rem),
      s.asleep_staged > 0 && inBed > 0 ? round((100 * s.asleep) / inBed, 1) : null,
    ];
  });
  const notes = [
    `Times are local in ${env.TIMEZONE}. A session belongs to the date you wake up; main marks the longest session ending that date, the others are naps.`,
    'Minutes come from the recorded stages: asleep is light + deep + rem + generic sleeping, efficiency is asleep / in bed.',
    `Only sessions from ${env.PRIMARY_SOURCE} are listed.`,
  ];
  if (stale.length > 0) notes.push(staleNote(stale));
  const answer: Answer = {
    sessions: {
      columns: [
        'wake_date',
        'start',
        'end',
        'main',
        'in_bed_min',
        'asleep_min',
        'awake_min',
        'light_min',
        'deep_min',
        'rem_min',
        'efficiency_pct',
      ],
      rows,
    },
    notes,
  };
  if (rows.length === 0) {
    notes.unshift('no data for these dates');
    answer.coverage = await coverage(env, ['sleep_in_bed_minutes']);
  }
  if (detail === 'stages') {
    const stageRows: Cell[][] = sessions.results.flatMap((s) =>
      SleepBody.parse(JSON.parse(s.body)).stages.map((st) => [
        s.d,
        localDateTime(clock, s.start_ms),
        st.stage,
        localClock(clock, Date.parse(st.start_time)),
        localClock(clock, Date.parse(st.end_time)),
        round((Date.parse(st.end_time) - Date.parse(st.start_time)) / 60_000, 1),
      ]),
    );
    answer.stages = { columns: ['wake_date', 'session_start', 'stage', 'start', 'end', 'minutes'], rows: stageRows };
  }
  return answer;
}
