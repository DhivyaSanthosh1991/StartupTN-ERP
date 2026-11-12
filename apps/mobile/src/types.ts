export interface PunchEvent {
  id: string; type: 'check_in' | 'check_out'; at: string; withinGeofence: boolean | null; geofenceName: string | null; flags: string[];
}
export interface BreakState {
  usedMinutes: number;
  onBreak: { id: string; kind: 'lunch' | 'other'; since: string } | null;
}
export interface TodayAttendance {
  date: string;
  breaks?: BreakState;
  state: 'not_started' | 'checked_in' | 'checked_out';
  canCheckIn: boolean;
  canCheckOut: boolean;
  locationConsent: boolean;
  photoConsent: boolean;
  attendanceMethod: 'selfie' | 'biometric';
  canPunch: boolean;
  selfieRequired: boolean;
  rules: { workStart: string; graceMinutes: number; fullDayMinutes: number; halfDayMinutes: number };
  openSince: string | null;
  events: PunchEvent[];
  day: { status: string | null; workedMinutes: number } | null;
  info: { holiday: string | null; weeklyOff: boolean; leave: string | null; od: boolean };
}
export interface TrackState {
  enabled: boolean;
  intervalMinutes: number;
  active: boolean;
  away: { id: string; leftAt: string; explained: boolean } | null;
  recorded?: boolean;
}
export interface Profile { id: string; fullName: string; empCode?: string }
