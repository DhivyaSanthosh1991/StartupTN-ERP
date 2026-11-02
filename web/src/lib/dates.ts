// All calendar days in this app are India dates (Asia/Kolkata), matching the server.

const TZ = 'Asia/Kolkata';
const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const clock = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
const clockSeconds = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export const todayIst = (now: Date = new Date()): string => dateParts.format(now);

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export const dayOfWeek = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function monthBounds(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number);
  return [`${month}-01`, new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)];
}

export const monthLabel = (month: string): string => `${MONTHS_LONG[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** '2026-11-03' -> '3 Nov 2026' */
export const fmtDate = (date: string): string => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;

/** '2026-11-03' -> 'Tue 3 Nov' */
export const fmtDay = (date: string): string => `${WEEKDAYS[dayOfWeek(date)]} ${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;

export function fmtRange(from: string, to: string): string {
  if (from === to) return fmtDay(from);
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return sameMonth ? `${WEEKDAYS[dayOfWeek(from)]} ${Number(from.slice(8, 10))} – ${fmtDay(to)}` : `${fmtDay(from)} – ${fmtDay(to)}`;
}

/** An instant -> '9:42 am' in India time. */
export const fmtClock = (iso: string | Date): string => clock.format(new Date(iso)).replace('AM', 'am').replace('PM', 'pm');

/** An instant -> 'HH:MM:SS' in India time (24 h), for the live clock. */
export const fmtClockSeconds = (d: Date): string => clockSeconds.format(d);

export function fmtDateTime(iso: string | Date): string {
  const d = new Date(iso);
  return `${fmtDay(todayIst(d))}, ${fmtClock(d)}`;
}

/** '09:30' -> '9:30 am' */
export function fmtHm(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** 462 -> '7h 42m' */
export function fmtMinutes(min: number): string {
  if (!min) return '0m';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export function fmtDays(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(1)} ${n === 1 ? 'day' : 'days'}`;
}

/** 'in 3 days', 'yesterday', '2 hours ago' */
export function relative(iso: string | Date, now: Date = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(ms);
  const units: [number, string][] = [[86_400_000, 'day'], [3_600_000, 'hour'], [60_000, 'minute']];
  for (const [size, name] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      const label = `${n} ${name}${n === 1 ? '' : 's'}`;
      return ms < 0 ? `${label} ago` : `in ${label}`;
    }
  }
  return 'just now';
}
