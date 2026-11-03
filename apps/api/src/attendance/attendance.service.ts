import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { AuthUser, hasRole } from '../common/auth.types';
import { DayRecalc } from '../common/day-recalc.service';
import { addDays, dayOfWeek, eachDate, hhmm, istDate, istMinutes, monthRange, todayIst } from '../common/dates';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { SettingsService } from '../common/settings.service';
import { Db, Queryable } from '../db/db.service';
import { StorageService } from '../documents/storage.service';
import { EmployeesService } from '../employees/employees.service';
import {
  DayResult, DayStatus, Fence, PunchEvent, deriveDayStatus, haversineMeters, isImpossibleTravel, matchGeofence, pairSessions, summarise,
} from './attendance-calc';
import { decodeSelfie, selfieKey } from './selfie';

/** A GPS fix worse than this is refused outright: it says nothing useful about where the person is. */
export const MAX_ACCURACY_M = 500;
const MAX_VIEW_DAYS = 93;
const MAX_RECOMPUTE_DAYS = 400;

export interface PunchInput {
  latitude: number;
  longitude: number;
  accuracyM?: number;
  note?: string;
  source: 'web' | 'mobile';
  /** A live photo taken at the moment of the punch: base64 JPEG, with or without the data-URL prefix. */
  selfie?: string;
}

export interface GeofenceInput {
  name: string;
  kind: 'office' | 'field';
  latitude: number;
  longitude: number;
  radiusM: number;
  active?: boolean;
}

type DaysByEmployee = Map<string, Map<string, DayResult>>;

@Injectable()
export class AttendanceService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly recalc: DayRecalc,
    private readonly employees: EmployeesService,
    private readonly storage: StorageService,
  ) {}

  private readonly log = new Logger(AttendanceService.name);

  onModuleInit() {
    this.recalc.register((q, employeeId, from, to) => this.recompute(q, employeeId, from, to));
  }

  // ---------------------------------------------------------------- geofences

  async geofences(includeInactive = false) {
    const rows = await this.db.rows(
      `select * from geofences ${includeInactive ? '' : 'where active'} order by active desc, name`);
    return rows.map(fenceView);
  }

  async createGeofence(actor: AuthUser, input: GeofenceInput) {
    return this.db.tx(async (q) => {
      const r = await q.query(
        `insert into geofences (name, kind, latitude, longitude, radius_m, active) values ($1,$2,$3,$4,$5,$6) returning *`,
        [input.name, input.kind, input.latitude, input.longitude, input.radiusM, input.active ?? true]);
      await this.audit.record({ actorId: actor.id, action: 'geofence.create', entityType: 'geofence', entityId: r.rows[0].id, after: input }, q);
      return fenceView(r.rows[0]);
    });
  }

  async updateGeofence(actor: AuthUser, id: string, patch: Partial<GeofenceInput>) {
    const before = await this.db.one('select * from geofences where id = $1', [id]);
    if (!before) throw notFound('GEOFENCE_NOT_FOUND', 'Location not found');
    const col: Record<string, string> = { name: 'name', kind: 'kind', latitude: 'latitude', longitude: 'longitude', radiusM: 'radius_m', active: 'active' };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [k, c] of Object.entries(col)) {
      const v = (patch as Record<string, unknown>)[k];
      if (v === undefined) continue;
      values.push(v);
      sets.push(`${c} = $${values.length}`);
    }
    if (sets.length) {
      values.push(id);
      await this.db.tx(async (q) => {
        await q.query(`update geofences set ${sets.join(', ')} where id = $${values.length}`, values);
        await this.audit.record({ actorId: actor.id, action: 'geofence.update', entityType: 'geofence', entityId: id, before: fenceView(before), after: patch }, q);
      });
    }
    return fenceView((await this.db.one('select * from geofences where id = $1', [id]))!);
  }

  // -------------------------------------------------------------------- punch

  /**
   * Records a check-in or check-out with the device's location. The time always comes from the
   * server. Being outside every fence, a poor GPS fix or an impossible jump from the previous
   * punch does not block the punch; it is flagged for the manager and HR to review.
   */
  async punch(user: AuthUser, kind: 'check_in' | 'check_out', input: PunchInput, now: Date = new Date()) {
    const s = await this.settings.get();
    if (input.accuracyM !== undefined && input.accuracyM > MAX_ACCURACY_M) {
      throw badRequest('GPS_TOO_INACCURATE',
        `Your location is only accurate to ${Math.round(input.accuracyM)} m. Please move to an open area or turn on precise location, then try again`);
    }
    const selfie = input.selfie === undefined ? null : decodeSelfie(input.selfie);
    if (input.selfie !== undefined && !selfie) {
      throw badRequest('SELFIE_INVALID', 'The photo could not be used. Please take the selfie again');
    }
    const fences: Fence[] = (await this.geofences()).map((f) => ({ id: f.id, name: f.name, latitude: f.latitude, longitude: f.longitude, radiusM: f.radiusM }));
    const workDate = istDate(now);
    const eventId = randomUUID();
    let storedKey: string | null = null;

    try {
      await this.db.tx(async (q) => {
        await q.query('select pg_advisory_xact_lock(hashtext($1))', [`punch:${user.id}`]);

        const emp = (await q.query('select location_consent_at, photo_consent_at, attendance_method, work_location_id from employees where id = $1', [user.id])).rows[0];
        const onDuty = (await q.query(
          `select 1 from od_requests where employee_id = $1 and kind = 'od' and status = 'approved' and from_date <= $2 and to_date >= $2 limit 1`,
          [user.id, workDate])).rows.length > 0;
        if (emp.attendance_method === 'biometric' && !onDuty) {
          throw conflict('BIOMETRIC_ONLY', 'Your attendance is recorded by the biometric machine. This button is only for approved on-duty days');
        }
        if (!emp.location_consent_at) {
          throw conflict('LOCATION_CONSENT_REQUIRED', 'Please read and accept the location notice before punching in');
        }
        if ((selfie || s.selfie_required) && !emp.photo_consent_at) {
          throw conflict('PHOTO_CONSENT_REQUIRED', 'Please read and accept the photo notice before punching in');
        }
        if (s.selfie_required && !selfie) {
          throw badRequest('SELFIE_REQUIRED', 'A selfie is needed to check in or out. Allow the camera and take the photo');
        }

        const todays = await this.eventsOn(q, user.id, workDate);
        const open = pairSessions(todays).openSince;
        if (kind === 'check_in' && open) throw conflict('ALREADY_CHECKED_IN', 'You are already checked in. Check out first');
        if (kind === 'check_out' && !open) throw conflict('NOT_CHECKED_IN', 'You have not checked in yet today');

        // A person is judged against their own work location. With none set, any location counts.
        const own = emp.work_location_id ? fences.find((f) => f.id === emp.work_location_id) : undefined;
        const match = matchGeofence(input.latitude, input.longitude, own ? [own] : fences);
        const flags: string[] = [];
        // On an approved on-duty day being away from the office is expected, so it is not flagged; the location is still saved.
        if (match.within === false && !onDuty) flags.push('outside_geofence');
        if (match.within === null) flags.push('no_geofence');
        if (input.accuracyM !== undefined && input.accuracyM > s.geofence_low_accuracy_m) flags.push('low_accuracy');

        const prev = (await q.query(
          `select latitude, longitude, event_at from attendance_events
            where employee_id = $1 and latitude is not null and not ('superseded' = any(flags)) and event_at > $2
            order by event_at desc limit 1`, [user.id, new Date(now.getTime() - 12 * 3_600_000)])).rows[0];
        if (prev && isImpossibleTravel(
          haversineMeters(prev.latitude, prev.longitude, input.latitude, input.longitude), now.getTime() - prev.event_at.getTime())) {
          flags.push('impossible_travel');
        }

        // The photo is stored before the row that points at it; if anything below fails it is removed again.
        if (selfie) {
          storedKey = selfieKey(user.id, workDate, eventId);
          await this.storage.putObject(storedKey, selfie, 'image/jpeg');
        }

        await q.query(
          `insert into attendance_events (id, employee_id, event_type, event_at, work_date, latitude, longitude, accuracy_m,
                                          geofence_id, within_geofence, flags, source, note, selfie_key)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [eventId, user.id, kind, now, workDate, input.latitude, input.longitude, input.accuracyM ?? null,
           match.fenceId, match.within, flags, input.source, input.note ?? null, storedKey]);
        await this.recompute(q, user.id, workDate, workDate, now);
      });
    } catch (err) {
      if (storedKey) await this.storage.delete(storedKey).catch(() => undefined);
      throw err;
    }
    return this.today(user);
  }

  private async eventsOn(q: Queryable, employeeId: string, date: string): Promise<PunchEvent[]> {
    const rows = (await q.query(
      `select event_type, event_at, flags from attendance_events where employee_id = $1 and work_date = $2 order by event_at`, [employeeId, date])).rows;
    return rows.map((r) => ({ type: r.event_type, at: r.event_at, flags: r.flags }));
  }

  // -------------------------------------------------------------------- today

  async today(user: AuthUser, now: Date = new Date()) {
    const date = todayIst(now);
    const s = await this.settings.get();
    const emp = await this.db.one('select location_consent_at, photo_consent_at, attendance_method from employees where id = $1', [user.id]);
    const events = await this.db.rows(
      `select e.id, e.event_type, e.event_at, e.latitude, e.longitude, e.accuracy_m, e.within_geofence, e.flags, e.source,
              e.selfie_key is not null as has_selfie, e.selfie_purged_at is not null as selfie_purged, g.name as geofence_name
         from attendance_events e left join geofences g on g.id = e.geofence_id
        where e.employee_id = $1 and e.work_date = $2 and not ('superseded' = any(e.flags)) order by e.event_at`, [user.id, date]);
    const sessions = pairSessions(events.map((e) => ({ type: e.event_type, at: e.event_at, flags: e.flags })));
    const day = (await this.computeDays(this.db, [user.id], date, date, now)).get(user.id)?.get(date) ?? null;

    const holiday = await this.db.one(`select name from holidays where holiday_date = $1 and not optional`, [date]);
    const leave = await this.db.one(
      `select day_part from leave_requests where employee_id = $1 and status = 'approved' and from_date <= $2 and to_date >= $2 limit 1`, [user.id, date]);
    const od = await this.db.one(
      `select 1 as x from od_requests where employee_id = $1 and kind = 'od' and status = 'approved' and from_date <= $2 and to_date >= $2 limit 1`, [user.id, date]);

    return {
      date,
      state: sessions.openSince ? 'checked_in' : events.length ? 'checked_out' : 'not_started',
      canCheckIn: !sessions.openSince,
      canCheckOut: !!sessions.openSince,
      locationConsent: !!emp?.location_consent_at,
      photoConsent: !!emp?.photo_consent_at,
      attendanceMethod: (emp?.attendance_method ?? 'selfie') as 'selfie' | 'biometric',
      /** False for people on the biometric machine, except on an approved on-duty day. */
      canPunch: (emp?.attendance_method ?? 'selfie') === 'selfie' || !!od,
      selfieRequired: s.selfie_required,
      selfieRetentionDays: s.selfie_retention_days,
      rules: { workStart: s.work_start, graceMinutes: s.grace_minutes, fullDayMinutes: s.full_day_minutes, halfDayMinutes: s.half_day_minutes },
      openSince: sessions.openSince,
      events: events.map((e) => ({
        id: e.id as string, type: e.event_type as string, at: e.event_at as Date, latitude: e.latitude as number | null,
        longitude: e.longitude as number | null, accuracyM: e.accuracy_m as number | null, withinGeofence: e.within_geofence as boolean | null,
        geofenceName: e.geofence_name as string | null, flags: e.flags as string[], source: e.source as string,
        selfie: e.has_selfie as boolean, selfiePurged: e.selfie_purged as boolean,
      })),
      day: day ? dayView(day) : null,
      info: {
        holiday: (holiday?.name as string | undefined) ?? null,
        weeklyOff: s.weekly_off_days.includes(dayOfWeek(date)),
        leave: leave ? (leave.day_part as string) : null,
        od: !!od,
      },
    };
  }

  // ------------------------------------------------------------------- months

  async monthFor(viewer: AuthUser, employeeId: string, month: string) {
    await this.assertCanView(viewer, employeeId);
    const [from, to] = monthRange(month);
    const days = (await this.computeDays(this.db, [employeeId], from, to)).get(employeeId) ?? new Map<string, DayResult>();
    const holidays = new Map((await this.db.rows(
      `select holiday_date::text as d, name from holidays where holiday_date between $1 and $2 and not optional`, [from, to])).map((h) => [h.d as string, h.name as string]));
    const list = eachDate(from, to).map((date) => {
      const d = days.get(date);
      return { date, dayOfWeek: dayOfWeek(date), holiday: holidays.get(date) ?? null, ...(d ? dayView(d) : emptyDay(date)) };
    });
    return { month, employeeId, days: list, summary: summarise(list) };
  }

  // ---------------------------------------------------------------- team views

  /** Active people this viewer may look at: their reporting line, or everyone for HR. */
  private async peopleInScope(viewer: AuthUser, date?: string) {
    const scope = await this.employees.teamScope(viewer);
    if (scope && !scope.length) return [];
    return this.db.rows(
      `select e.id, e.emp_code, e.full_name, e.designation, d.name as department
         from employees e left join departments d on d.id = e.department_id
        where e.status = 'active' and ($1::uuid[] is null or e.id = any($1))
          and ($2::date is null or e.date_of_joining is null or e.date_of_joining <= $2)
        order by e.full_name`, [scope, date ?? null]);
  }

  async teamDay(viewer: AuthUser, date: string) {
    const people = await this.peopleInScope(viewer, date);
    const days = await this.computeDays(this.db, people.map((p) => p.id), date, date);
    return people.map((p) => {
      const d = days.get(p.id)?.get(date);
      return { employeeId: p.id as string, empCode: p.emp_code as string, fullName: p.full_name as string,
        designation: p.designation as string | null, department: p.department as string | null, ...(d ? dayView(d) : emptyDay(date)) };
    });
  }

  async teamSummary(viewer: AuthUser, month: string) {
    const [from, to] = monthRange(month);
    const people = await this.peopleInScope(viewer);
    const days = await this.computeDays(this.db, people.map((p) => p.id), from, to);
    return people.map((p) => ({
      employeeId: p.id as string, empCode: p.emp_code as string, fullName: p.full_name as string,
      department: p.department as string | null, summary: summarise([...(days.get(p.id)?.values() ?? [])]),
    }));
  }

  /** The raw punches of one person on one day, with locations — for a manager or HR reviewing a flag. */
  async trail(viewer: AuthUser, employeeId: string, date: string) {
    await this.assertCanView(viewer, employeeId);
    const rows = await this.db.rows(
      `select e.id, e.event_type, e.event_at, e.latitude, e.longitude, e.accuracy_m, e.within_geofence, e.flags, e.source, e.note,
              e.selfie_key is not null as has_selfie, e.selfie_purged_at is not null as selfie_purged,
              g.name as geofence_name, g.latitude as fence_lat, g.longitude as fence_lon
         from attendance_events e left join geofences g on g.id = e.geofence_id
        where e.employee_id = $1 and e.work_date = $2 order by e.event_at`, [employeeId, date]);
    return rows.map((e) => ({
      id: e.id as string, type: e.event_type as string, at: e.event_at as Date, latitude: e.latitude as number | null,
      longitude: e.longitude as number | null, accuracyM: e.accuracy_m as number | null, withinGeofence: e.within_geofence as boolean | null,
      geofenceName: e.geofence_name as string | null,
      distanceM: e.latitude != null && e.fence_lat != null ? Math.round(haversineMeters(e.latitude, e.longitude, e.fence_lat, e.fence_lon)) : null,
      flags: e.flags as string[], source: e.source as string, note: e.note as string | null,
      selfie: e.has_selfie as boolean, selfiePurged: e.selfie_purged as boolean,
    }));
  }

  /**
   * The photo taken at one punch. Only the person themselves, their reporting managers and HR may see it,
   * and every look by someone other than the owner is written to the audit log (once per 10 minutes per viewer,
   * so a page of thumbnails is one entry, not a flood).
   */
  async selfie(viewer: AuthUser, eventId: string): Promise<Buffer> {
    const ev = await this.db.one(
      'select employee_id, selfie_key, selfie_purged_at from attendance_events where id = $1', [eventId]);
    if (!ev) throw notFound('EVENT_NOT_FOUND', 'Punch not found');
    await this.assertCanView(viewer, ev.employee_id);
    if (!ev.selfie_key) {
      throw notFound('SELFIE_NOT_FOUND', ev.selfie_purged_at ? 'This photo was deleted after the retention period' : 'No photo was taken for this punch');
    }
    const photo = await this.storage.getObject(ev.selfie_key);
    if (!photo) throw notFound('SELFIE_NOT_FOUND', 'The photo is no longer available');
    if (viewer.id !== ev.employee_id) {
      const recent = await this.db.one(
        `select 1 as x from audit_log where actor_id = $1 and action = 'attendance.selfie_view' and entity_id = $2
            and created_at > now() - interval '10 minutes' limit 1`, [viewer.id, ev.employee_id]);
      if (!recent) {
        await this.audit.record({ actorId: viewer.id, action: 'attendance.selfie_view', entityType: 'employee', entityId: ev.employee_id, after: { eventId } });
      }
    }
    return photo;
  }

  /** Deletes photos older than the retention period. The punch, time and location stay; only the picture goes. */
  async purgeExpiredSelfies(now: Date = new Date()): Promise<{ removed: number }> {
    const s = await this.settings.get();
    const cutoff = new Date(now.getTime() - s.selfie_retention_days * 86_400_000);
    let removed = 0;
    for (let batch = 0; batch < 40; batch++) {
      const old = await this.db.rows(
        `select id, selfie_key from attendance_events where selfie_key is not null and event_at < $1 order by event_at limit 250`, [cutoff]);
      if (!old.length) break;
      for (const e of old) {
        try {
          await this.storage.delete(e.selfie_key);
        } catch (err) {
          this.log.warn(`Could not delete photo ${e.selfie_key}: ${(err as Error).message}`);
          continue; // keep the key so the next run tries again
        }
        await this.db.query('update attendance_events set selfie_key = null, selfie_purged_at = now() where id = $1', [e.id]);
        removed++;
      }
      if (old.length < 250) break;
    }
    if (removed) {
      await this.audit.record({ actorId: null, action: 'attendance.selfie_purge', entityType: 'attendance', after: { removed, olderThanDays: s.selfie_retention_days } });
    }
    return { removed };
  }

  private async assertCanView(viewer: AuthUser, employeeId: string) {
    if (viewer.id === employeeId || hasRole(viewer, 'hr_admin')) return;
    const scope = await this.employees.teamScope(viewer);
    if (!scope?.includes(employeeId)) throw forbidden('FORBIDDEN', 'You do not have access to this attendance record');
  }

  // ------------------------------------------------------------------- export

  /** The month's attendance register as CSV, for everyone employed at any point in the month. */
  async exportCsv(month: string): Promise<string> {
    const [from, to] = monthRange(month);
    const people = await this.db.rows(
      `select e.id, e.emp_code, e.full_name, d.name as department
         from employees e left join departments d on d.id = e.department_id
        where (e.date_of_joining is null or e.date_of_joining <= $2) and (e.exit_date is null or e.exit_date >= $1)
        order by e.emp_code`, [from, to]);
    const days = await this.computeDays(this.db, people.map((p) => p.id), from, to);
    const lines = [['Employee code', 'Name', 'Department', 'Date', 'Status', 'First in', 'Last out', 'Worked (min)', 'Late', 'Flags'].join(',')];
    for (const p of people) {
      for (const date of eachDate(from, to)) {
        const d = days.get(p.id)?.get(date);
        if (!d) continue;
        lines.push([
          p.emp_code, p.full_name, p.department ?? '', date, d.status, d.firstIn ? clock(d.firstIn) : '', d.lastOut ? clock(d.lastOut) : '',
          d.workedMinutes, d.late ? 'Yes' : 'No', d.flags.join(' '),
        ].map(csvCell).join(','));
      }
    }
    return lines.join('\r\n') + '\r\n';
  }

  // ---------------------------------------------------------- computing days

  /**
   * Works out what each day looks like for the given people, from their punches and from approved
   * leave, on-duty, permissions and the holiday list. Nothing is stored here, so what people see
   * is always current. Returns only days that have something to show.
   */
  async computeDays(q: Queryable, employeeIds: string[], from: string, to: string, now: Date = new Date()): Promise<DaysByEmployee> {
    const out: DaysByEmployee = new Map(employeeIds.map((id) => [id, new Map<string, DayResult>()]));
    if (!employeeIds.length || to < from) return out;
    const s = await this.settings.get();
    const today = todayIst(now);
    const rules = { work_start: s.work_start, grace_minutes: s.grace_minutes, full_day_minutes: s.full_day_minutes, half_day_minutes: s.half_day_minutes };

    const emps = new Map((await q.query('select id, date_of_joining, exit_date from employees where id = any($1::uuid[])', [employeeIds])).rows.map((e) => [e.id as string, e]));
    const holidays = new Set((await q.query(`select holiday_date::text as d from holidays where holiday_date between $1 and $2 and not optional`, [from, to])).rows.map((h) => h.d as string));

    const events = new Map<string, PunchEvent[]>();
    for (const e of (await q.query(
      `select employee_id, event_type, event_at, work_date, flags, (selfie_key is not null or selfie_purged_at is not null) as has_selfie
         from attendance_events where employee_id = any($1::uuid[]) and work_date between $2 and $3`, [employeeIds, from, to])).rows) {
      const key = `${e.employee_id}|${e.work_date}`;
      events.set(key, [...(events.get(key) ?? []), { type: e.event_type, at: e.event_at, flags: e.flags, selfie: e.has_selfie }]);
    }

    const leaveFull = new Set<string>();
    const leaveHalf = new Set<string>();
    for (const l of (await q.query(
      `select employee_id, from_date, to_date, day_part from leave_requests
        where status = 'approved' and employee_id = any($1::uuid[]) and from_date <= $3 and to_date >= $2`, [employeeIds, from, to])).rows) {
      for (const date of eachDate(l.from_date < from ? from : l.from_date, l.to_date > to ? to : l.to_date)) {
        (l.day_part === 'full' ? leaveFull : leaveHalf).add(`${l.employee_id}|${date}`);
      }
    }
    const od = new Set<string>();
    for (const o of (await q.query(
      `select employee_id, from_date, to_date from od_requests
        where kind = 'od' and status = 'approved' and employee_id = any($1::uuid[]) and from_date <= $3 and to_date >= $2`, [employeeIds, from, to])).rows) {
      for (const date of eachDate(o.from_date < from ? from : o.from_date, o.to_date > to ? to : o.to_date)) od.add(`${o.employee_id}|${date}`);
    }
    const permissions = new Map<string, { from: string; to: string }[]>();
    for (const p of (await q.query(
      `select employee_id, from_date, from_time, to_time from od_requests
        where kind = 'permission' and status = 'approved' and employee_id = any($1::uuid[]) and from_date between $2 and $3`, [employeeIds, from, to])).rows) {
      const key = `${p.employee_id}|${p.from_date}`;
      permissions.set(key, [...(permissions.get(key) ?? []), { from: hhmm(p.from_time), to: hhmm(p.to_time) }]);
    }

    for (const id of employeeIds) {
      const emp = emps.get(id);
      if (!emp) continue;
      for (const date of eachDate(from, to)) {
        const key = `${id}|${date}`;
        const result = deriveDayStatus({
          date, today, rules,
          employed: (!emp.date_of_joining || date >= emp.date_of_joining) && (!emp.exit_date || date <= emp.exit_date) &&
            (!s.attendance_start_date || date >= s.attendance_start_date),
          holiday: holidays.has(date), weeklyOff: s.weekly_off_days.includes(dayOfWeek(date)),
          leaveFull: leaveFull.has(key), leaveHalf: leaveHalf.has(key), od: od.has(key), selfieRequired: s.selfie_required,
          permissions: permissions.get(key) ?? [], events: events.get(key) ?? [],
        });
        if (result) out.get(id)!.set(date, result);
      }
    }
    return out;
  }

  /**
   * Refreshes the stored attendance register (attendance_days) for past days and today. Called in
   * the same transaction as whatever changed it: a punch, an approved leave or correction. Future
   * days are never stored; they are worked out when someone looks.
   */
  async recompute(q: Queryable, employeeId: string, from: string, to: string, now: Date = new Date()): Promise<void> {
    const end = to > todayIst(now) ? todayIst(now) : to;
    if (end < from) return;
    if (eachDate(from, end).length > MAX_RECOMPUTE_DAYS) throw badRequest('RANGE_TOO_LONG', `At most ${MAX_RECOMPUTE_DAYS} days can be refreshed at once`);
    const days = (await this.computeDays(q, [employeeId], from, end, now)).get(employeeId)!;
    for (const date of eachDate(from, end)) {
      const d = days.get(date);
      if (!d) {
        await q.query('delete from attendance_days where employee_id = $1 and work_date = $2', [employeeId, date]);
        continue;
      }
      await q.query(
        `insert into attendance_days (employee_id, work_date, first_in, last_out, worked_minutes, status, late, flags, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8, now())
         on conflict (employee_id, work_date) do update
           set first_in = excluded.first_in, last_out = excluded.last_out, worked_minutes = excluded.worked_minutes,
               status = excluded.status, late = excluded.late, flags = excluded.flags, updated_at = now()`,
        [employeeId, date, d.firstIn, d.lastOut, d.workedMinutes, d.status, d.late, d.flags]);
    }
  }

  /**
   * Nightly: brings the register up to date for everyone, going back a week so that late-approved
   * leave, holiday changes and corrections are picked up. Each person is done on their own, so one
   * failure cannot hold up the rest.
   */
  async runNightly(now: Date = new Date()): Promise<{ employees: number; from: string; to: string; failed: number }> {
    const to = todayIst(now);
    return this.refreshAll(addDays(to, -7), to, now);
  }

  async refreshAll(from: string, to: string, now: Date = new Date()) {
    if (eachDate(from, to).length > MAX_VIEW_DAYS) throw badRequest('RANGE_TOO_LONG', `At most ${MAX_VIEW_DAYS} days can be refreshed at once`);
    const people = await this.db.rows(`select id from employees where status = 'active'`);
    let failed = 0;
    for (const p of people) {
      try {
        await this.db.tx((q) => this.recompute(q, p.id, from, to, now));
      } catch {
        failed++;
      }
    }
    return { employees: people.length, from, to, failed };
  }
}

// ------------------------------------------------------------------ helpers

function fenceView(r: any) {
  return {
    id: r.id as string, name: r.name as string, kind: r.kind as 'office' | 'field', latitude: r.latitude as number,
    longitude: r.longitude as number, radiusM: r.radius_m as number, active: r.active as boolean,
  };
}

function dayView(d: DayResult) {
  return { status: d.status as DayStatus | null, firstIn: d.firstIn, lastOut: d.lastOut, workedMinutes: d.workedMinutes, late: d.late, flags: d.flags };
}

function emptyDay(_date: string) {
  return { status: null as DayStatus | null, firstIn: null as Date | null, lastOut: null as Date | null, workedMinutes: 0, late: false, flags: [] as string[] };
}

function clock(d: Date): string {
  const m = istMinutes(d);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Quotes a CSV cell, and defuses spreadsheet formulas ("=...", "+...") that someone may have typed into a name. */
export function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
