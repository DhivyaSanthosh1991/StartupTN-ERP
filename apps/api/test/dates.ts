import { addDays, dayOfWeek, todayIst } from '../src/common/dates';

/**
 * A Monday at least `minAhead` days from today whose following three weeks stay inside one calendar
 * year, so a test can apply for leave on it without tripping the year-boundary rules, whenever it runs.
 */
export function futureMonday(minAhead = 14): string {
  let d = addDays(todayIst(), minAhead);
  while (dayOfWeek(d) !== 1) d = addDays(d, 1);
  while (d.slice(0, 4) !== addDays(d, 21).slice(0, 4)) d = addDays(d, 7);
  return d;
}

/** The latest Monday-to-Friday date on or before today. */
export function recentWeekday(): string {
  let d = todayIst();
  while (dayOfWeek(d) === 0 || dayOfWeek(d) === 6) d = addDays(d, -1);
  return d;
}

export const yearOf = (date: string) => Number(date.slice(0, 4));

/** A Monday 7–13 days ago: its whole working week is in the past, yet inside the correction window. */
export function pastMonday(): string {
  let d = addDays(todayIst(), -7);
  while (dayOfWeek(d) !== 1) d = addDays(d, -1);
  return d;
}

/** The latest Monday-to-Friday date strictly before today. */
export function previousWeekday(): string {
  let d = addDays(todayIst(), -1);
  while (dayOfWeek(d) === 0 || dayOfWeek(d) === 6) d = addDays(d, -1);
  return d;
}
