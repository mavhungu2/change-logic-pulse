import type { IsoWeekStart, QuestionId, SummaryInputs } from '../tenancy/contract.js';

/**
 * The summary payload. Defined once and consumed by both the API and the React
 * app, so a renamed field breaks the build rather than the screen.
 */
export type QuestionSummary =
  | {
      readonly id: QuestionId;
      readonly type: 'rating';
      /** null when nobody answered — an average of nothing is not zero. */
      readonly average: number | null;
      readonly count: number;
    }
  | {
      readonly id: QuestionId;
      readonly type: 'yes_no';
      readonly counts: { readonly yes: number; readonly no: number };
    };

export interface WeeklySummary {
  readonly weekStart: IsoWeekStart;
  readonly completedCount: number;
  readonly eligibleCount: number;
  readonly completionRate: number;
  readonly questions: readonly QuestionSummary[];
}

const round = (value: number, places: number): number =>
  Number.parseFloat(value.toFixed(places));

/**
 * Turns database tallies into the response payload. Pure: the division lives
 * here, the aggregation lives in SQL, and neither needs the other to be tested.
 */
export function summarise(inputs: SummaryInputs): WeeklySummary {
  return {
    weekStart: inputs.weekStart,
    completedCount: inputs.completedCount,
    eligibleCount: inputs.eligibleCount,
    // An organization with no members has a rate of 0, not a division by zero.
    completionRate:
      inputs.eligibleCount === 0
        ? 0
        : round(inputs.completedCount / inputs.eligibleCount, 3),
    questions: inputs.tallies.map((tally) =>
      tally.type === 'rating'
        ? {
            id: tally.questionId,
            type: 'rating',
            average: tally.count === 0 ? null : round(tally.sum / tally.count, 2),
            count: tally.count,
          }
        : {
            id: tally.questionId,
            type: 'yes_no',
            counts: { yes: tally.yes, no: tally.no },
          },
    ),
  };
}
