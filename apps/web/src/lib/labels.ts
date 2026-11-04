import type { Tone } from '@/components/ui';
import type { DayStatus } from './types';

export const DAY_STATUS: Record<DayStatus, { label: string; short: string; tone: Tone }> = {
  present: { label: 'Present', short: 'P', tone: 'peacock' },
  half_day: { label: 'Half day', short: '½', tone: 'marigold' },
  absent: { label: 'Absent', short: 'A', tone: 'kumkum' },
  leave: { label: 'On leave', short: 'L', tone: 'indigo' },
  od: { label: 'On duty', short: 'OD', tone: 'indigo' },
  holiday: { label: 'Holiday', short: 'H', tone: 'neutral' },
  weekly_off: { label: 'Weekly off', short: 'Off', tone: 'neutral' },
  incomplete: { label: 'No check-out', short: '…', tone: 'marigold' },
};

/** An open day is "No check-out" only once it is over; today's is simply still running. */
export function dayStatusOf(status: DayStatus, flags: string[] = []) {
  if (status === 'incomplete' && !flags.includes('missing_checkout')) return { label: 'Working now', short: '…', tone: 'peacock' as Tone };
  return DAY_STATUS[status];
}

/** Plain-language names for the notes the system attaches to a day or a punch. */
export const FLAG_LABEL: Record<string, string> = {
  outside_geofence: 'Outside the office area',
  no_geofence: 'No office area is set up',
  low_accuracy: 'Weak GPS signal',
  impossible_travel: 'Moved further than possible since the last punch',
  regularised: 'Corrected after approval',
  missing_checkout: 'No check-out',
  short_hours: 'Fewer hours than a half day',
  worked_on_off_day: 'Worked on a day off',
  worked_on_leave: 'Worked on a day of leave',
  half_day_leave: 'Half-day leave',
  no_attendance: 'Came in for no part of the working half',
  od_no_selfie: 'On duty, but no selfie check-in',
  late_for_duty: 'Reached the duty venue after the time given',
};

/** Where a punch came from, in words. */
export const SOURCE_LABEL: Record<string, string> = {
  biometric: 'Biometric machine',
  regularisation: 'Added by correction',
};

export const ATTENDANCE_METHOD: Record<string, string> = {
  selfie: 'Selfie and location in the portal',
  biometric: 'Biometric machine at head office',
};

export const flagLabel = (f: string) => FLAG_LABEL[f] ?? f.replace(/_/g, ' ');

/** Flags a manager or HR should look at, as opposed to routine notes. */
export const ATTENTION_FLAGS = new Set(['outside_geofence', 'impossible_travel', 'missing_checkout', 'low_accuracy', 'no_geofence', 'od_no_selfie', 'late_for_duty']);

export const DAY_PART: Record<string, string> = { full: 'Full day', first_half: 'First half', second_half: 'Second half' };

export const REQUEST_TYPE_LABEL: Record<string, string> = {
  leave: 'Leave', od: 'On duty', permission: 'Permission', regularisation: 'Attendance correction', od_home: 'Going home after duty',
};

export const EMPLOYMENT_TYPE: Record<string, string> = { permanent: 'Permanent', contract: 'Contract', consultant: 'Consultant', intern: 'Intern' };
export const ROLE_LABEL: Record<string, string> = { hod: 'Head of department', md: 'Managing director', hr_admin: 'HR', finance: 'Finance', super_admin: 'System administrator' };

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
