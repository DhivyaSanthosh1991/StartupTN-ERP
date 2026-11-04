import { istMinutes, minutesOf } from '../common/dates';

// ------------------------------------------------------------------ geography

const EARTH_RADIUS_M = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres between two latitude/longitude points. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface Fence {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number;
}

export interface FenceMatch {
  fenceId: string | null;
  fenceName: string | null;
  distanceM: number | null;
  /** null when no geofence is configured, so there is nothing to be inside or outside of. */
  within: boolean | null;
}

/**
 * Compares a location with every active fence. A point inside several fences is matched to the
 * smallest of them, the most specific place ("Head office" rather than a wide campus fence around
 * it); a point outside all of them is matched to the nearest, so a reviewer can see how far away it
 * was. The reported GPS accuracy is deliberately not used to give the benefit of the doubt: poor
 * accuracy is flagged separately instead.
 */
export function matchGeofence(lat: number, lon: number, fences: Fence[]): FenceMatch {
  if (!fences.length) return { fenceId: null, fenceName: null, distanceM: null, within: null };
  const measured = fences.map((f) => {
    const distance = haversineMeters(lat, lon, f.latitude, f.longitude);
    return { f, distance, gap: distance - f.radiusM }; // gap <= 0 means inside
  });
  const inside = measured.filter((m) => m.gap <= 0).sort((a, b) => a.f.radiusM - b.f.radiusM || a.distance - b.distance);
  const pick = inside[0] ?? measured.sort((a, b) => a.gap - b.gap)[0];
  return { fenceId: pick.f.id, fenceName: pick.f.name, distanceM: Math.round(pick.distance), within: pick.gap <= 0 };
}

/** Faster than this between two punches cannot be real travel, so the second location is suspect. */
export const IMPOSSIBLE_SPEED_KMH = 150;
export const IMPOSSIBLE_MIN_DISTANCE_M = 1000;

export function isImpossibleTravel(distanceM: number, elapsedMs: number): boolean {
  if (distanceM < IMPOSSIBLE_MIN_DISTANCE_M) return false;
  const hours = Math.max(elapsedMs, 1000) / 3_600_000;
  return distanceM / 1000 / hours > IMPOSSIBLE_SPEED_KMH;
}

// -------------------------------------------------------------- day-by-day

export type DayStatus = 'present' | 'half_day' | 'absent' | 'leave' | 'od' | 'holiday' | 'weekly_off' | 'incomplete';

export interface PunchEvent {
  type: 'check_in' | 'check_out';
  at: Date;
  flags: string[];
  /** A selfie was taken at this punch (even if the photo has since been deleted). */
  selfie?: boolean;
  /** The punch was made at a duty location (not back at the person's own office). */
  site?: boolean;
}

export interface Sessions {
  minutes: number;
  /** Time of the check-in that has no check-out yet, if any. */
  openSince: Date | null;
  firstIn: Date | null;
  lastOut: Date | null;
}

/**
 * Pairs check-ins with check-outs in time order. A second check-in while one is open and a
 * check-out with nothing open are ignored. Events replaced by an approved correction carry the
 * 'superseded' flag and take no part. Only closed sessions count towards worked time.
 */
export function pairSessions(events: PunchEvent[]): Sessions {
  const live = events.filter((e) => !e.flags.includes('superseded')).sort((a, b) => a.at.getTime() - b.at.getTime());
  let open: Date | null = null;
  let minutes = 0;
  let firstIn: Date | null = null;
  let lastOut: Date | null = null;
  for (const e of live) {
    if (e.type === 'check_in') {
      if (!open) open = e.at;
      firstIn ??= e.at;
    } else if (open) {
      minutes += Math.round((e.at.getTime() - open.getTime()) / 60_000);
      open = null;
      lastOut = e.at;
    }
  }
  return { minutes, openSince: open, firstIn, lastOut };
}

export interface DayRules {
  work_start: string;
  grace_minutes: number;
  full_day_minutes: number;
  half_day_minutes: number;
}

export interface DayInput {
  date: string;
  /** Today's date in India. Days after it only show what is already planned. */
  today: string;
  /** False before the person joined or after they left. */
  employed: boolean;
  holiday: boolean;
  weeklyOff: boolean;
  leaveFull: boolean;
  leaveHalf: boolean;
  od: boolean;
  /** The fixed time the person must reach the duty venue (first day of the duty), if they gave one. */
  odMeetingTime?: string | null;
  /** Selfies are required, so a past on-duty day with no selfie punch is flagged. */
  selfieRequired?: boolean;
  /** Approved permissions that day, as clock times. */
  permissions: { from: string; to: string }[];
  events: PunchEvent[];
  rules: DayRules;
}

export interface DayResult {
  date: string;
  status: DayStatus;
  firstIn: Date | null;
  lastOut: Date | null;
  workedMinutes: number;
  late: boolean;
  flags: string[];
}

const permissionMinutes = (p: { from: string; to: string }[]) => p.reduce((n, x) => n + Math.max(minutesOf(x.to) - minutesOf(x.from), 0), 0);

/**
 * What a day looks like. Returns null when there is nothing to show yet: a day in the future with
 * nothing planned, today before anyone has punched, or a date outside the person's employment.
 */
export function deriveDayStatus(input: DayInput): DayResult | null {
  const { date, today, rules } = input;
  if (!input.employed) return null;

  const sessions = pairSessions(input.events);
  const live = input.events.filter((e) => !e.flags.includes('superseded'));
  const flags = new Set<string>();
  for (const e of live) for (const f of e.flags) flags.add(f);
  const result = (status: DayStatus, late = false): DayResult => ({
    date, status, firstIn: sessions.firstIn, lastOut: sessions.lastOut, workedMinutes: sessions.minutes,
    late, flags: [...flags].sort(),
  });
  const worked = sessions.minutes > 0 || sessions.firstIn !== null;

  // Days off come first: leave or duty that spans a weekend or holiday does not turn it into a working day.
  if (input.holiday || input.weeklyOff) {
    if (worked) flags.add('worked_on_off_day');
    return result(input.holiday ? 'holiday' : 'weekly_off');
  }
  if (input.leaveFull) {
    if (worked) flags.add('worked_on_leave');
    return result('leave');
  }
  if (input.od) {
    // On duty, everyone marks attendance with a geo-tagged selfie. A finished on-duty day with none is flagged
    // for the manager and HR; the day still counts as on duty.
    const proved = live.some((e) => e.selfie || e.flags.includes('regularised'));
    if (input.selfieRequired && date < today && !proved) flags.add('od_no_selfie');
    // With a stated reporting time, arriving well after it is noted. Not visiting the office first is never flagged.
    const firstSite = live.filter((e) => e.type === 'check_in' && e.site).sort((a, b) => a.at.getTime() - b.at.getTime())[0];
    if (input.odMeetingTime && firstSite && istMinutes(firstSite.at) > minutesOf(input.odMeetingTime) + rules.grace_minutes) flags.add('late_for_duty');
    return result('od');
  }

  if (date > today) {
    // Only a planned half-day leave is worth showing ahead of time.
    if (!input.leaveHalf) return null;
    flags.add('half_day_leave');
    return result('half_day');
  }

  const credit = sessions.minutes + permissionMinutes(input.permissions);
  if (input.leaveHalf) flags.add('half_day_leave');

  // Arrival after work start plus grace counts as late, unless an approved permission covers the arrival.
  const isLate = (): boolean => {
    if (!sessions.firstIn || input.leaveHalf) return false;
    const arrival = istMinutes(sessions.firstIn);
    if (arrival <= minutesOf(rules.work_start) + rules.grace_minutes) return false;
    return !input.permissions.some((p) => minutesOf(p.from) <= minutesOf(rules.work_start) + rules.grace_minutes && minutesOf(p.to) >= arrival);
  };

  if (!worked) {
    if (input.leaveHalf) {
      flags.add('no_attendance');
      return result('half_day');
    }
    return date < today ? result('absent') : null;
  }

  if (sessions.openSince) {
    if (date === today) return result('incomplete', isLate());
    flags.add('missing_checkout');
    return result('incomplete', isLate());
  }

  // With half a day's leave approved, only the other half has to be worked.
  if (input.leaveHalf) {
    if (credit < rules.half_day_minutes) flags.add('short_hours');
    return result('half_day');
  }
  if (credit >= rules.full_day_minutes) return result('present', isLate());
  if (credit >= rules.half_day_minutes) return result('half_day', isLate());
  flags.add('short_hours');
  return result('absent');
}

// ---------------------------------------------------------------- summaries

export interface MonthSummary {
  present: number;
  halfDay: number;
  absent: number;
  leave: number;
  od: number;
  holidays: number;
  weeklyOffs: number;
  incomplete: number;
  /** Past days that were left open; today's still-running day is not one of them. */
  missingCheckout: number;
  late: number;
  workedMinutes: number;
}

export function summarise(days: { status: DayStatus | null; late: boolean; workedMinutes: number; flags?: string[] }[]): MonthSummary {
  const s: MonthSummary = { present: 0, halfDay: 0, absent: 0, leave: 0, od: 0, holidays: 0, weeklyOffs: 0, incomplete: 0, missingCheckout: 0, late: 0, workedMinutes: 0 };
  for (const d of days) {
    if (!d.status) continue;
    if (d.status === 'present') s.present++;
    else if (d.status === 'half_day') s.halfDay++;
    else if (d.status === 'absent') s.absent++;
    else if (d.status === 'leave') s.leave++;
    else if (d.status === 'od') s.od++;
    else if (d.status === 'holiday') s.holidays++;
    else if (d.status === 'weekly_off') s.weeklyOffs++;
    else if (d.status === 'incomplete') s.incomplete++;
    if (d.status === 'incomplete' && d.flags?.includes('missing_checkout')) s.missingCheckout++;
    if (d.late) s.late++;
    s.workedMinutes += d.workedMinutes;
  }
  return s;
}
