import { describe, expect, it } from 'vitest';
import { InvalidWeekError, parseWeekStart, weekStartOf } from './week.js';

const at = (iso: string) => new Date(iso);

describe('weekStartOf', () => {
  it('returns a Monday unchanged', () => {
    expect(weekStartOf(at('2026-09-14T00:00:00.000Z'))).toBe('2026-09-14');
  });

  it('steps Sunday back to the START of its own week, not forward', () => {
    // The classic off-by-one: getUTCDay() is 0 for Sunday, so a naive
    // subtraction leaves it put and files it under the wrong week.
    expect(weekStartOf(at('2026-09-20T00:00:00.000Z'))).toBe('2026-09-14');
    expect(weekStartOf(at('2026-09-13T00:00:00.000Z'))).toBe('2026-09-07');
  });

  it('maps every day of one week to the same Monday', () => {
    const week = [14, 15, 16, 17, 18, 19, 20].map((d) =>
      weekStartOf(at(`2026-09-${d}T12:00:00.000Z`)),
    );
    expect(new Set(week)).toEqual(new Set(['2026-09-14']));
  });

  it('ignores time of day, including the last millisecond of a week', () => {
    expect(weekStartOf(at('2026-09-20T23:59:59.999Z'))).toBe('2026-09-14');
    expect(weekStartOf(at('2026-09-21T00:00:00.000Z'))).toBe('2026-09-21');
  });

  it('crosses a year boundary without resetting', () => {
    // 2027-01-01 is a Friday; its week began in the previous year.
    expect(weekStartOf(at('2027-01-01T00:00:00.000Z'))).toBe('2026-12-28');
  });

  it('handles a leap day', () => {
    expect(weekStartOf(at('2028-02-29T00:00:00.000Z'))).toBe('2028-02-28');
  });

  it('is unaffected by the host timezone', () => {
    // Same instant, expressed with an offset. UTC is what counts.
    expect(weekStartOf(at('2026-09-21T01:00:00.000+02:00'))).toBe('2026-09-14');
  });
});

describe('parseWeekStart', () => {
  it('normalises any day in the week to its Monday', () => {
    expect(parseWeekStart('2026-09-16')).toBe('2026-09-14');
    expect(parseWeekStart('2026-09-14')).toBe('2026-09-14');
  });

  it('rejects a date that does not exist', () => {
    // Date.parse would silently roll this to 2026-03-02.
    expect(() => parseWeekStart('2026-02-30')).toThrow(InvalidWeekError);
  });

  it('rejects malformed input', () => {
    for (const bad of ['2026-1-1', '2026-13-01', '14-09-2026', 'yesterday', '']) {
      expect(() => parseWeekStart(bad)).toThrow(InvalidWeekError);
    }
  });
});
