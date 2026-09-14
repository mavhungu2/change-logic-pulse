/**
 * The ISO week calculation. Owned by the main thread, per CLAUDE.md §8.
 *
 * "This week" is the ISO calendar week: Monday start, UTC. It exists exactly
 * once because response submission, the summary query and the seed all need it,
 * and three copies would be three opinions about what week it is — one of which
 * would disagree with the `UNIQUE (survey_id, user_id, week_start)` constraint
 * and produce a duplicate-week bug that only shows up near a boundary.
 */

import type { IsoWeekStart } from '../tenancy/contract.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class InvalidWeekError extends Error {
  constructor(readonly input: string) {
    super(`Not a valid ISO date (YYYY-MM-DD): ${JSON.stringify(input)}`);
    this.name = 'InvalidWeekError';
  }
}

/**
 * The Monday of the ISO week containing `instant`, as `YYYY-MM-DD` in UTC.
 * Time of day is discarded, so any instant within a week maps to the same
 * Monday.
 */
export function weekStartOf(instant: Date = new Date()): IsoWeekStart {
  const day = new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
  );

  // getUTCDay() is 0=Sunday..6=Saturday; ISO weeks run Monday..Sunday, so
  // Sunday is the *end* of its week and must step back six days, not zero.
  const daysSinceMonday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - daysSinceMonday);

  return day.toISOString().slice(0, 10) as IsoWeekStart;
}

/**
 * Parses a `?week=YYYY-MM-DD` parameter. Any day in a week is accepted and
 * normalised to that week's Monday — the parameter names a week, not a day, and
 * a Wednesday identifies one unambiguously. The resolved `weekStart` is echoed
 * in every response, so the caller always sees which week it got.
 *
 * @throws InvalidWeekError when the input is not a real calendar date.
 */
export function parseWeekStart(input: string): IsoWeekStart {
  if (!ISO_DATE.test(input)) throw new InvalidWeekError(input);

  const parsed = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new InvalidWeekError(input);

  // Date.parse accepts impossible dates and rolls them over: '2026-02-30'
  // silently becomes 2026-03-02. Only a round-trip catches that.
  if (parsed.toISOString().slice(0, 10) !== input) throw new InvalidWeekError(input);

  return weekStartOf(parsed);
}
