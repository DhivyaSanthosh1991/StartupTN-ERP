import { Injectable } from '@nestjs/common';
import { Db } from '../db/db.service';

export interface OrgSettings {
  work_start: string;
  grace_minutes: number;
  full_day_minutes: number;
  half_day_minutes: number;
  weekly_off_days: number[];
  leave_year_start_month: number;
  leave_backdate_days: number;
  regularisation_window_days: number;
  permission_max_minutes: number;
  permission_monthly_limit: number;
  geofence_low_accuracy_m: number;
  /** First day attendance is tracked (go-live). Earlier days show nothing, not "absent". null = from each person's joining date. */
  attendance_start_date: string | null;
  /** Check-in and check-out take a live selfie. Switch off only while cameras are unavailable. */
  selfie_required: boolean;
  /** Selfies are deleted this many days after they were taken; the punch and its location stay. */
  selfie_retention_days: number;
  /** Random location checks per working day. 0 switches them off. */
  presence_checks_per_day: number;
  /** How long a person has to answer a random check. */
  presence_response_minutes: number;
  /** At least this long between one check and the next, and after checking in. */
  presence_min_gap_minutes: number;
  /** While checked in, the phone shares its location now and then. HR sees who has left the office area. */
  tracking_enabled: boolean;
  /** How often the portal sends a location reading while checked in. Longer saves the phone's battery. */
  tracking_interval_minutes: number;
  /** Someone outside their work location for this long, with no duty, break or permission, is reported to HR. */
  tracking_away_grace_minutes: number;
  /** Location readings are deleted after this many days. Alerts are kept. */
  tracking_retention_days: number;
}

export const SETTING_DEFAULTS: OrgSettings = {
  work_start: '09:30',
  grace_minutes: 15,
  full_day_minutes: 480,
  half_day_minutes: 240,
  weekly_off_days: [0, 6],
  leave_year_start_month: 1,
  leave_backdate_days: 7,
  regularisation_window_days: 15,
  permission_max_minutes: 120,
  permission_monthly_limit: 2,
  geofence_low_accuracy_m: 100,
  attendance_start_date: null,
  selfie_required: true,
  selfie_retention_days: 90,
  presence_checks_per_day: 2,
  presence_response_minutes: 10,
  presence_min_gap_minutes: 120,
  tracking_enabled: true,
  tracking_interval_minutes: 10,
  tracking_away_grace_minutes: 10,
  tracking_retention_days: 30,
};

const TTL_MS = 30_000;

@Injectable()
export class SettingsService {
  private cache: { at: number; value: OrgSettings } | null = null;

  constructor(private readonly db: Db) {}

  async get(): Promise<OrgSettings> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.value;
    const rows = await this.db.rows<{ key: string; value: unknown }>('select key, value from org_settings');
    const value: Record<string, unknown> = { ...SETTING_DEFAULTS };
    for (const r of rows) if (r.key in SETTING_DEFAULTS) value[r.key] = r.value;
    this.cache = { at: Date.now(), value: value as unknown as OrgSettings };
    return this.cache.value;
  }

  invalidate() {
    this.cache = null;
  }
}
