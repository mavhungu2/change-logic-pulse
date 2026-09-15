import { Injectable } from '@nestjs/common';
import type {
  IsoWeekStart,
  QuestionTally,
  SummaryInputs,
  SummaryReporting,
  SurveyId,
} from './contract.js';
import { TenantDb } from './tenant-db.js';

interface TallyJson {
  readonly questionId: string;
  readonly text: string;
  readonly type: 'rating' | 'yes_no';
  readonly ratingCount: number;
  readonly ratingSum: number;
  readonly yes: number;
  readonly no: number;
}

interface SummaryRow {
  readonly eligible_count: number;
  readonly completed_count: number;
  readonly tallies: readonly TallyJson[];
}

@Injectable()
export class PrismaSummaryRepository implements SummaryReporting {
  constructor(private readonly db: TenantDb) {}

  /**
   * Everything the summary needs, aggregated by PostgreSQL in one round trip.
   *
   * Nothing is reduced in Node: no answer row is ever loaded. The database
   * returns three counts and a sum per question, and the domain divides. A week
   * with a thousand responses transfers the same handful of numbers as a week
   * with two.
   *
   * It is also one snapshot. Three separate queries could observe a response
   * submitted between them and report a completed count that disagrees with the
   * tallies it is printed beside.
   *
   * The completion-rate denominator is `users WHERE role = 'member'` — Managers
   * author surveys, they are not the responding population. (See CLAUDE.md §2;
   * the brief's wording is ambiguous and this reading is recorded in SOLUTION.md.)
   * There is no org_id filter anywhere in this query: row-level security has
   * already restricted every one of these tables to the caller's organization,
   * so `users` here means "members of this org" and nothing wider.
   *
   * Returns null when the survey is not visible — another tenant's id and a
   * nonexistent id are indistinguishable, because `target` is the driving table
   * and yields no rows either way.
   */
  async loadSummaryInputs(
    surveyId: SurveyId,
    weekStart: IsoWeekStart,
  ): Promise<SummaryInputs | null> {
    const rows = await this.db.run(
      async (tx) => tx.$queryRaw<SummaryRow[]>`
        WITH target AS (
          SELECT s.id FROM surveys s WHERE s.id = CAST(${surveyId} AS uuid)
        ),
        week_responses AS (
          SELECT r.id FROM responses r JOIN target t ON r.survey_id = t.id
           WHERE r.week_start = CAST(${weekStart} AS date)
        ),
        tallies AS (
          SELECT q.id, q.text, q.type, q.position,
                 count(a.rating_value)::int                          AS rating_count,
                 coalesce(sum(a.rating_value), 0)::int               AS rating_sum,
                 count(*) FILTER (WHERE a.bool_value IS TRUE)::int   AS yes_count,
                 count(*) FILTER (WHERE a.bool_value IS FALSE)::int  AS no_count
            FROM questions q
            JOIN target t ON q.survey_id = t.id
            LEFT JOIN answers a
              ON a.question_id = q.id
             AND a.response_id IN (SELECT id FROM week_responses)
           GROUP BY q.id, q.text, q.type, q.position
        )
        SELECT
          (SELECT count(*)::int FROM users WHERE role = 'member') AS eligible_count,
          (SELECT count(*)::int FROM week_responses)              AS completed_count,
          coalesce(
            (SELECT json_agg(json_build_object(
                      'questionId',  tl.id,
                      'text',        tl.text,
                      'type',        tl.type,
                      'ratingCount', tl.rating_count,
                      'ratingSum',   tl.rating_sum,
                      'yes',         tl.yes_count,
                      'no',          tl.no_count) ORDER BY tl.position)
               FROM tallies tl),
            '[]'::json) AS tallies
        FROM target`,
    );

    const row = rows[0];
    if (!row) return null;

    return {
      weekStart,
      eligibleCount: row.eligible_count,
      completedCount: row.completed_count,
      tallies: row.tallies.map(toTally),
    };
  }
}

/** Type-keyed, so a third question type is a new branch here and nowhere else. */
function toTally(tally: TallyJson): QuestionTally {
  return tally.type === 'rating'
    ? {
        questionId: tally.questionId,
        text: tally.text,
        type: 'rating',
        sum: tally.ratingSum,
        count: tally.ratingCount,
      }
    : { questionId: tally.questionId, text: tally.text, type: 'yes_no', yes: tally.yes, no: tally.no };
}
