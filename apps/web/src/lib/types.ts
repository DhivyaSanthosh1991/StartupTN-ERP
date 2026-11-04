export type DayStatus = 'present' | 'half_day' | 'absent' | 'leave' | 'od' | 'holiday' | 'weekly_off' | 'incomplete';

export interface PunchEvent {
  id: string;
  type: 'check_in' | 'check_out';
  at: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  withinGeofence: boolean | null;
  geofenceName: string | null;
  flags: string[];
  source: string;
  /** A selfie was taken at this punch and is still held. */
  selfie: boolean;
  /** The selfie was deleted after the retention period. */
  selfiePurged: boolean;
}

export interface DayView {
  status: DayStatus | null;
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;
  late: boolean;
  flags: string[];
}

export interface BreakState {
  usedMinutes: number;
  onBreak: { id: string; kind: 'lunch' | 'other'; since: string } | null;
  breaks: { id: string; kind: 'lunch' | 'other'; note: string | null; startedAt: string; endedAt: string | null; minutes: number }[];
}

export interface TodayAttendance {
  date: string;
  breaks?: BreakState;
  state: 'not_started' | 'checked_in' | 'checked_out';
  canCheckIn: boolean;
  canCheckOut: boolean;
  locationConsent: boolean;
  photoConsent: boolean;
  /** How this person's attendance is taken. */
  attendanceMethod: 'selfie' | 'biometric';
  /** False for people on the biometric machine, except on an approved on-duty day. */
  canPunch: boolean;
  selfieRequired: boolean;
  selfieRetentionDays: number;
  rules: { workStart: string; graceMinutes: number; fullDayMinutes: number; halfDayMinutes: number };
  openSince: string | null;
  events: PunchEvent[];
  day: DayView | null;
  info: { holiday: string | null; weeklyOff: boolean; leave: string | null; od: boolean };
}

export interface MonthSummary {
  present: number; halfDay: number; absent: number; leave: number; od: number; holidays: number;
  weeklyOffs: number; incomplete: number; missingCheckout: number; late: number; workedMinutes: number;
}

export interface MonthDay extends DayView {
  date: string;
  dayOfWeek: number;
  holiday: string | null;
}

export interface LeaveBalance {
  leaveTypeId: string; code: string; name: string; paid: boolean; allowHalfDay: boolean; unlimited: boolean;
  entitlement: number; used: number; pending: number; balance: number; available: number; year: number;
  event?: boolean; carriedOver?: number; carriedOverUntil?: string | null;
}

export interface Dashboard {
  date: string;
  attendance: TodayAttendance;
  month: { month: string; summary: MonthSummary };
  leaveBalances: LeaveBalance[];
  myRequests: {
    pending: { leave: number; od: number; permission: number; regularisation: number; total: number };
    upcoming: { kind: 'leave' | 'od' | 'permission'; id: string; from: string; to: string; label: string; dayPart: string; fromTime: string | null; toTime: string | null }[];
  };
  approvals: { waiting: number; overdue: number; oldest: { approvalRequestId: string; typeLabel: string; summary: string; requester: string; dueAt: string | null }[] };
  team: { total: number; present: number; checkedInNow: number; onLeave: number; onDuty: number; dayOff: number; notYetIn: number } | null;
  awayToday: { employeeId: string; fullName: string; designation: string | null; away: 'leave' | 'od'; dayPart: string }[];
  holidays: { date: string; name: string; optional: boolean }[];
  notices: { id: string; title: string; body: string; published_at: string; expires_on: string | null; author: string | null }[];
  expiringDocuments: DocumentView[];
}

export interface DocumentView {
  id: string; employeeId: string; employeeName: string; empCode: string;
  category: { code: string; name: string }; title: string; fileName: string; contentType: string; sizeBytes: number;
  status: string; visibility: 'employee_and_hr' | 'hr_only'; expiresOn: string | null;
  expiry: 'valid' | 'expiring_soon' | 'expired' | null; uploadedBy: { id: string; name: string }; createdAt: string;
}

export interface LeaveRequest {
  id: string; employeeId: string; employeeName: string; empCode: string; leaveTypeId: string; leaveTypeCode: string; leaveTypeName: string;
  fromDate: string; toDate: string; dayPart: 'full' | 'first_half' | 'second_half'; days: number; lopDays: number; reason: string; status: string;
  approvalRequestId: string | null; currentApprover: string | null; lastComment: string | null; createdAt: string;
}

export interface OdRequest {
  id: string; kind: 'od' | 'permission'; employeeId: string; employeeName: string; empCode: string;
  fromDate: string; toDate: string; fromTime: string | null; toTime: string | null; minutes: number | null;
  location: string | null; purpose: string; status: string; approvalRequestId: string | null;
  currentApprover: string | null; lastComment: string | null; createdAt: string;
  meetingTime?: string | null;
  stops?: { location: string; meetingTime: string | null; date: string }[];
  siteVisits?: { type: 'check_in' | 'check_out'; at: string; latitude: number | null; longitude: number | null }[];
}

export interface RegularisationRequest {
  id: string; employeeId: string; employeeName: string; empCode: string; workDate: string;
  checkInTime: string | null; checkOutTime: string | null; reason: string; status: string;
  approvalRequestId: string | null; currentApprover: string | null; lastComment: string | null; createdAt: string;
}

export interface DirectoryPerson {
  id: string; empCode: string; fullName: string; officialEmail: string; designation: string | null;
  departmentId: string | null; departmentName: string | null; reportingManagerId: string | null; photoUrl: string | null;
}

export interface EmployeeProfile extends DirectoryPerson {
  phone: string | null; employmentType: 'permanent' | 'contract' | 'consultant' | 'intern'; dateOfJoining: string | null;
  dateOfBirth: string | null; gender: 'female' | 'male' | 'other' | null; workLocationId: string | null; workLocationName: string | null; reportingManagerName: string | null; status: 'active' | 'inactive' | 'exited'; exitDate: string | null;
  locationConsentAt: string | null; photoConsentAt: string | null; attendanceMethod: 'selfie' | 'biometric'; biometricCode: string | null; roles: string[]; directReports: number; isManager: boolean;
}

export interface Department { id: string; name: string; headEmployeeId: string | null; headName: string | null; headcount: number }
