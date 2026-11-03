// All "calendar day" logic in this system is Asia/Kolkata. India has no daylight saving,
// so the offset is a constant +05:30 and no time-zone library is needed.

const IST_OFFSET_MIN = 330;
const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' of an instant, as seen in India. */
export function istDate(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

/** Minutes since midnight (India) of an instant. */
export function istMinutes(d: Date): number {
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** The instant at which 'HH:MM' (India) occurs on the given India calendar date. */
export function istInstant(date: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - IST_OFFSET_MIN) * 60_000);
}

export function todayIst(now: Date = new Date()): string {
  return istDate(now);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday */
export function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function diffDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Every date from..to inclusive. */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
    new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

/** [first day, last day] of a 'YYYY-MM' month. */
export function monthRange(month: string): [string, string] {
  const first = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return [first, last];
}

/** The leave year a date falls in, given the month the leave year starts (1 = calendar year). */
export function leaveYearOf(date: string, startMonth: number): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m >= startMonth ? y : y - 1;
}

export function hhmm(time: string): string {
  return time.slice(0, 5);
}

export function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11-03' -> '3 Nov 2026', for emails and approval summaries. */
export function prettyDate(date: string): string {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}
