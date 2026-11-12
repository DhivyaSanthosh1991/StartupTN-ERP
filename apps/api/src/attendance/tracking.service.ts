import { Injectable } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { istDate, istMinutes, minutesOf } from '../common/dates';
import { conflict, notFound } from '../common/errors';
import { SettingsService } from '../common/settings.service';
import { Db, Queryable } from '../db/db.service';
import { Fence, haversineMeters, matchGeofence, pairSessions } from './attendance-calc';
import { BreaksService } from './breaks.service';

/** A reading less exact than this says little about where the person is, so it is not kept. */
export const TRACK_MAX_ACCURACY_M = 300;
/** Readings closer together than this are ignored (a second tab, a retry). */
const MIN_SECONDS_BETWEEN = 90;

export interface PingInput { latitude: number; longitude: number; accuracyM?: number; source?: 'web' | 'app' }
export type AwayKind = 'official' | 'break' | 'personal' | 'other';

/**
 * Location while someone is checked in, and only then. The portal sends one coarse reading every few minutes
 * (the interval is a setting), which the phone can answer from wifi and mobile towers, so the battery is hardly
 * touched. Nothing is asked before check-in, after check-out, or during a break.
 *
 * If the readings put the person outside their work location for longer than the grace period, and nothing
 * explains it (no on-duty, break or approved permission), HR gets an alert and the person is asked why.
 * The alert closes by itself when a reading comes back inside.
 *
 * Without a native app, readings only come while the portal is open on the phone. The same endpoint is what
 * a later mobile app would use.
 */
@Injectable()
export class TrackingService {
  constructor(private readonly db: Db, private readonly settings: SettingsService, private readonly breaks: BreaksService) {}

  /** Is the phone expected to be sending readings right now, and is there an unanswered alert? */
  async state(user: AuthUser, now: Date = new Date(), q: Queryable = this.db) {
    const s = await this.settings.get();
    const base = { enabled: s.tracking_enabled, intervalMinutes: s.tracking_interval_minutes };
    if (!s.tracking_enabled) return { ...base, active: false, away: null };
    const ctx = await this.context(q, user.id, now);
    const away = (await q.query(
      `select id, left_at, reason_kind from away_alerts where employee_id = $1 and returned_at is null`, [user.id])).rows[0];
    return {
      ...base,
      active: ctx.eligible && ctx.checkedIn && !ctx.onBreak,
      away: away ? { id: away.id as string, leftAt: away.left_at as Date, explained: !!away.reason_kind } : null,
    };
  }

  async ping(user: AuthUser, input: PingInput, now: Date = new Date()) {
    const s = await this.settings.get();
    if (!s.tracking_enabled) return { recorded: false, ...(await this.state(user, now)) };

    const recorded = await this.db.tx(async (q) => {
      await q.query('select pg_advisory_xact_lock(hashtext($1))', [`track:${user.id}`]);
      const ctx = await this.context(q, user.id, now);
      // Only between check-in and check-out, and not during a break.
      if (!ctx.eligible || !ctx.checkedIn || ctx.onBreak) return false;
      if (input.accuracyM !== undefined && input.accuracyM > TRACK_MAX_ACCURACY_M) return false;
      const last = (await q.query('select max(recorded_at) as t from location_pings where employee_id = $1 and work_date = $2', [user.id, ctx.date])).rows[0];
      if (last?.t && now.getTime() - last.t.getTime() < MIN_SECONDS_BETWEEN * 1000) return false;

      const fences: Fence[] = (await q.query('select id, name, latitude, longitude, radius_m from geofences where active')).rows
        .map((f) => ({ id: f.id, name: f.name, latitude: f.latitude, longitude: f.longitude, radiusM: f.radius_m }));
      const own = ctx.workLocationId ? fences.find((f) => f.id === ctx.workLocationId) : undefined;
      const match = matchGeofence(input.latitude, input.longitude, own ? [own] : fences);
      const target = own ?? fences.find((f) => f.id === match.fenceId);
      const distance = target ? Math.round(haversineMeters(input.latitude, input.longitude, target.latitude, target.longitude)) : null;
      // A reading too rough to tell inside from outside never counts as "outside".
      const rough = input.accuracyM !== undefined && input.accuracyM > s.geofence_low_accuracy_m;
      const within = match.within === false && rough ? null : match.within;

      await q.query(
        `insert into location_pings (employee_id, work_date, recorded_at, latitude, longitude, accuracy_m, geofence_id, within_fence, distance_m, source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [user.id, ctx.date, now, input.latitude, input.longitude, input.accuracyM ?? null, match.fenceId, within, distance, input.source ?? 'web']);

      if (within === true) {
        await q.query('update away_alerts set returned_at = $2 where employee_id = $1 and returned_at is null', [user.id, now]);
        return true;
      }
      if (within !== false || ctx.excused) return true;

      // Outside since the last reading that was inside (or the first of the day).
      const since = (await q.query(
        `select min(recorded_at) as t from location_pings
          where employee_id = $1 and work_date = $2 and within_fence = false
            and recorded_at > coalesce((select max(recorded_at) from location_pings where employee_id = $1 and work_date = $2 and within_fence = true), '-infinity')`,
        [user.id, ctx.date])).rows[0]?.t as Date | undefined;
      if (!since || now.getTime() - since.getTime() < s.tracking_away_grace_minutes * 60_000) return true;
      await q.query(
        `insert into away_alerts (employee_id, work_date, left_at, raised_at) values ($1,$2,$3,$4) on conflict do nothing`,
        [user.id, ctx.date, since, now]);
      return true;
    });
    return { recorded, ...(await this.state(user, now)) };
  }

  /** The person says why they are away. "Break" also switches them to break mode. */
  async explain(user: AuthUser, id: string, input: { kind: AwayKind; note?: string }, now: Date = new Date()) {
    const alert = await this.db.one('select id, employee_id, returned_at from away_alerts where id = $1', [id]);
    if (!alert || alert.employee_id !== user.id) throw notFound('NOT_FOUND', 'This alert was not found');
    await this.db.query(
      `update away_alerts set reason_kind = $2, reason_note = $3, explained_at = $4 where id = $1`,
      [id, input.kind, input.note?.trim() || null, now]);
    if (input.kind === 'break' && !alert.returned_at) {
      const b = await this.breaks.state(user, now);
      if (!b.onBreak) await this.breaks.start(user, { kind: 'other', note: input.note }, now).catch((e) => { if (e?.response?.code !== 'NOT_CHECKED_IN') throw e; });
    }
    return this.state(user, now);
  }

  /** HR: who has left the office area today, with what they said. */
  async alerts(date: string, now: Date = new Date()) {
    const rows = await this.db.rows(
      `select a.id, a.left_at, a.raised_at, a.returned_at, a.reason_kind, a.reason_note, e.full_name, e.emp_code
         from away_alerts a join employees e on e.id = a.employee_id where a.work_date = $1 order by a.raised_at`, [date]);
    return rows.map((r) => ({
      id: r.id as string, employeeName: r.full_name as string, empCode: r.emp_code as string,
      leftAt: r.left_at as Date, returnedAt: r.returned_at as Date | null,
      minutesAway: Math.round(((r.returned_at ?? now).getTime() - r.left_at.getTime()) / 60_000),
      reasonKind: r.reason_kind as AwayKind | null, reasonNote: r.reason_note as string | null,
    }));
  }

  /** HR: everyone checked in right now with the latest reading we have. */
  async live(now: Date = new Date()) {
    const date = istDate(now);
    const rows = await this.db.rows(
      `select e.id, e.full_name, e.emp_code, p.recorded_at, p.within_fence, p.distance_m,
              (select event_type from attendance_events where employee_id = e.id and work_date = $1 order by event_at desc limit 1) as last_event,
              exists (select 1 from work_breaks b where b.employee_id = e.id and b.ended_at is null) as on_break,
              exists (select 1 from od_requests o where o.employee_id = e.id and o.kind = 'od' and o.status = 'approved' and o.from_date <= $1 and o.to_date >= $1) as on_duty
         from employees e
         left join lateral (select recorded_at, within_fence, distance_m from location_pings where employee_id = e.id and work_date = $1 order by recorded_at desc limit 1) p on true
        where exists (select 1 from attendance_events a where a.employee_id = e.id and a.work_date = $1)
        order by e.full_name`, [date]);
    return rows.filter((r) => r.last_event === 'check_in').map((r) => ({
      employeeId: r.id as string, employeeName: r.full_name as string, empCode: r.emp_code as string,
      lastSeenAt: r.recorded_at as Date | null, minutesAgo: r.recorded_at ? Math.round((now.getTime() - r.recorded_at.getTime()) / 60_000) : null,
      place: (r.on_break ? 'break' : r.on_duty ? 'duty' : r.within_fence === true ? 'inside' : r.within_fence === false ? 'outside' : 'unknown') as 'break' | 'duty' | 'inside' | 'outside' | 'unknown',
      distanceM: r.distance_m as number | null,
    }));
  }

  /** Called by the daily cleanup. */
  async purge(now: Date = new Date()): Promise<{ removed: number }> {
    const s = await this.settings.get();
    const cutoff = new Date(now.getTime() - s.tracking_retention_days * 86_400_000);
    const res = await this.db.query('delete from location_pings where recorded_at < $1', [cutoff]);
    return { removed: res.rowCount ?? 0 };
  }

  private async context(q: Queryable, employeeId: string, now: Date) {
    const date = istDate(now);
    const emp = (await q.query('select attendance_method, location_consent_at, work_location_id from employees where id = $1', [employeeId])).rows[0];
    const events = (await q.query(
      `select event_type, event_at, flags from attendance_events where employee_id = $1 and work_date = $2 order by event_at`, [employeeId, date])).rows;
    const checkedIn = !!pairSessions(events.map((e) => ({ type: e.event_type, at: e.event_at, flags: e.flags }))).openSince;
    const onBreak = !!(await q.query('select 1 from work_breaks where employee_id = $1 and ended_at is null', [employeeId])).rows[0];
    const duty = !!(await q.query(
      `select 1 from od_requests where employee_id = $1 and kind = 'od' and status = 'approved' and from_date <= $2 and to_date >= $2 limit 1`, [employeeId, date])).rows[0];
    const perm = (await q.query(
      `select from_time, to_time from od_requests where employee_id = $1 and kind = 'permission' and status = 'approved' and from_date = $2`, [employeeId, date])).rows;
    const nowMin = istMinutes(now);
    const inPermission = perm.some((p) => p.from_time && p.to_time && nowMin >= minutesOf(String(p.from_time).slice(0, 5)) && nowMin <= minutesOf(String(p.to_time).slice(0, 5)));
    return {
      date, checkedIn, onBreak,
      eligible: !!emp && emp.attendance_method === 'selfie' && !!emp.location_consent_at,
      workLocationId: (emp?.work_location_id ?? null) as string | null,
      excused: onBreak || duty || inPermission,
    };
  }
}
