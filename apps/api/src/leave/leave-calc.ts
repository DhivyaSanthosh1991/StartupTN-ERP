import { dayOfWeek, eachDate } from '../common/dates';

export type DayPart = 'full' | 'first_half' | 'second_half';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Leave days a request consumes: weekly offs and holidays inside the range are not counted;
 * a half-day request counts 0.5 (and only if that date is a working day).
 */
export function countLeaveDays(input: {
  from: string;
  to: string;
  dayPart: DayPart;
  holidays: Set<string>;
  weeklyOffDays: number[];
}): { days: number; workingDates: string[] } {
  const workingDates = eachDate(input.from, input.to).filter(
    (d) => !input.weeklyOffDays.includes(dayOfWeek(d)) && !input.holidays.has(d),
  );
  const days = input.dayPart === 'full' ? workingDates.length : workingDates.length ? 0.5 : 0;
  return { days, workingDates };
}

/** First and last date of leave year `year` when leave years start in `startMonth` (1 = calendar year). */
export function leaveYearBounds(year: number, startMonth: number): [string, string] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const first = `${year}-${pad(startMonth)}-01`;
  const endYear = startMonth === 1 ? year : year + 1;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const last = new Date(Date.UTC(endYear, endMonth, 0)).toISOString().slice(0, 10);
  return [first, last];
}

/** The twelve 'YYYY-MM' months of a leave year, in order. */
export function leaveMonths(year: number, startMonth: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const m0 = startMonth - 1 + i;
    out.push(`${year + Math.floor(m0 / 12)}-${String((m0 % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Entitlement credited up front. Someone who joins part-way through the leave year gets the
 * share of the year left (counting the joining month), rounded to the nearest half day.
 */
export function prorateUpfront(entitlement: number, joiningDate: string | null, year: number, startMonth: number): number {
  if (!joiningDate) return entitlement;
  const months = leaveMonths(year, startMonth);
  const joinMonth = joiningDate.slice(0, 7);
  const idx = months.indexOf(joinMonth);
  if (idx <= 0) return entitlement; // joined before the year (idx -1 and joined earlier) or in its first month
  return Math.round(((entitlement * (12 - idx)) / 12) * 2) / 2;
}

/**
 * What to credit for the k-th month (1..12) of the leave year. Using the cumulative target keeps
 * the twelve months summing to exactly the annual entitlement, with no rounding drift.
 */
export function monthlyAccrual(entitlement: number, k: number): number {
  return round2(round2((entitlement * k) / 12) - round2((entitlement * (k - 1)) / 12));
}

/**
 * Last day a rolled-over balance of leave year `year` can still be used: the end of the year plus
 * `months` more months (April-March year, 3 months -> 30 June). With 0 months it is the year's last day.
 */
export function rollingExpiry(year: number, startMonth: number, months: number): string {
  const [, last] = leaveYearBounds(year, startMonth);
  const y = Number(last.slice(0, 4));
  const m = Number(last.slice(5, 7));
  return new Date(Date.UTC(y, m - 1 + months + 1, 0)).toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD dates (to - from). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
