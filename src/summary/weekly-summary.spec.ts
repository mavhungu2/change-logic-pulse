import { describe, expect, it } from 'vitest';
import type { IsoWeekStart, SummaryInputs } from '../tenancy/contract.js';
import { summarise } from './weekly-summary.js';

const WEEK = '2026-09-14' as IsoWeekStart;

const inputs = (over: Partial<SummaryInputs> = {}): SummaryInputs => ({
  weekStart: WEEK,
  eligibleCount: 3,
  completedCount: 2,
  tallies: [],
  ...over,
});

describe('summarise', () => {
  it('divides completed by eligible members', () => {
    expect(summarise(inputs()).completionRate).toBe(0.667);
  });

  it('treats an organization with no members as 0, not NaN', () => {
    const summary = summarise(inputs({ eligibleCount: 0, completedCount: 0 }));
    expect(summary.completionRate).toBe(0);
    expect(Number.isNaN(summary.completionRate)).toBe(false);
  });

  it('can exceed nothing: everyone responding is exactly 1', () => {
    expect(summarise(inputs({ eligibleCount: 4, completedCount: 4 })).completionRate).toBe(1);
  });

  it('averages ratings from the sum and count the database returned', () => {
    const summary = summarise(
      inputs({ tallies: [{ questionId: 'q1', text: 'How was your week?', type: 'rating', sum: 15, count: 4 }] }),
    );
    expect(summary.questions[0]).toEqual({
      id: 'q1',
      text: 'How was your week?',
      type: 'rating',
      average: 3.75,
      count: 4,
    });
  });

  it('reports no average when nobody answered, rather than zero', () => {
    const summary = summarise(
      inputs({ tallies: [{ questionId: 'q1', text: 'How was your week?', type: 'rating', sum: 0, count: 0 }] }),
    );
    expect(summary.questions[0]).toEqual({
      id: 'q1',
      text: 'How was your week?',
      type: 'rating',
      average: null,
      count: 0,
    });
  });

  it('passes yes/no counts through untouched', () => {
    const summary = summarise(
      inputs({ tallies: [{ questionId: 'q2', text: 'Blocked?', type: 'yes_no', yes: 3, no: 1 }] }),
    );
    expect(summary.questions[0]).toEqual({
      id: 'q2',
      text: 'Blocked?',
      type: 'yes_no',
      counts: { yes: 3, no: 1 },
    });
  });
});
