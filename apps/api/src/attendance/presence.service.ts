import { Injectable } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { istDate } from '../common/dates';
import { badRequest, conflict, notFound } from '../common/errors';
import { SettingsService } from '../common/settings.service';
import { Db, Queryable } from '../db/db.service';
import { Fence, haversineMeters, matchGeofence, pairSessions } from './attendance-calc';

/** The browser asks about once a minute; this is the chance that one of those asks turns into a check. */
export const CHANCE_PER_ASK = 0.03;
/** A check nobody answered comes back this long after it ran out. */
export const RETRY_AFTER_MINUTES = 15;

export interface PresenceInput { latitude: number; longitude: number; accuracyM?: number }

/**
 * Now and then, at a time nobody can predict, a person who is checked in is asked to confirm where they
 * are. They answer from their phone and the server compares the location with their work location.
 *
 * Checks only start while the portal is open on their device (a browser cannot be woken when it is
 * closed), so a check that exists was seen. An unanswered one is marked missed after the allowed time.
 * Nobody is asked on an approved on-duty day, while on a break, or when not checked in.
 */
@Injectable()
export class PresenceService {
  constructor(private readonly db: Db, private readonly settings: SettingsService) {}

  /** Called by the open portal every minute. Returns the check waiting for an answer, if there is one. */
  async poll(user: AuthUser, now: Date = new Date(), random: () => number = Math.random, onChange?: (q: Queryable, date: string) => Promise<void>) {
    const s = await this.settings.get();
    const date = istDate(now);
    return this.db.tx(async (q) => {
      await q.query('select pg_advisory_xact_lock(hashtext($1))', [`presence:${user.id}`]);

      // Unanswered checks past their time become "missed".
      const missed = (await q.query(
        `update presence_checks set status = 'missed' where employee_id = $1 and status = 'pending' and expires_at <= $2 returning work_date::text as d`,
        [user.id, now])).rows;
      for (const m of missed) if (onChange) await onChange(q, m.d);

      const pending = (await q.query(
        `select id, asked_at, expires_at from presence_checks where employee_id = $1 and status = 'pending'`, [user.id])).rows[0];
      if (pending) return { id: pending.id as string, askedAt: pending.asked_at as Date, expiresAt: pending.expires_at as Date };
      if (s.presence_checks_per_day <= 0) return null;

      const emp = (await q.query('select attendance_method, location_consent_at from employees where id = $1', [user.id])).rows[0];
      if (!emp || emp.attendance_method !== 'selfie' || !emp.location_consent_at) return null;
      const onBreak = (await q.query('select 1 from work_breaks where employee_id = $1 and ended_at is null', [user.id])).rows[0];
      if (onBreak) return null;

      const events = (await q.query(
        `select event_type, event_at, flags from attendance_events where employee_id = $1 and work_date = $2 order by event_at`, [user.id, date])).rows;
      const sessions = pairSessions(events.map((e) => ({ type: e.event_type, at: e.event_at, flags: e.flags })));
      if (!sessions.openSince) return null;

      // Someone who let a check run out is asked once more, 15 minutes after it ran out.
      const unanswered = (await q.query(
        `select c.id, c.expires_at from presence_checks c
          where c.employee_id = $1 and c.work_date = $2 and c.status = 'missed' and c.retry_of is null
            and not exists (select 1 from presence_checks r where r.retry_of = c.id)
          order by c.asked_at desc limit 1`, [user.id, date])).rows[0];
      if (unanswered) {
        if (now.getTime() - unanswered.expires_at.getTime() < RETRY_AFTER_MINUTES * 60_000) return null;
        const expires = new Date(now.getTime() + s.presence_response_minutes * 60_000);
        const row = (await q.query(
          `insert into presence_checks (employee_id, work_date, asked_at, expires_at, retry_of) values ($1,$2,$3,$4,$5) returning id`,
          [user.id, date, now, expires, unanswered.id])).rows[0];
        return { id: row.id as string, askedAt: now, expiresAt: expires };
      }

      const gap = s.presence_min_gap_minutes * 60_000;
      const last = (await q.query(
        `select count(*) filter (where retry_of is null)::int as n, max(asked_at) as last from presence_checks where employee_id = $1 and work_date = $2`, [user.id, date])).rows[0];
      if (last.n >= s.presence_checks_per_day) return null;
      // Not straight after checking in, and not straight after the last check.
      const since = Math.max(sessions.openSince.getTime(), last.last ? last.last.getTime() : 0);
      if (now.getTime() - since < gap) return null;
      if (random() >= CHANCE_PER_ASK) return null;

      const expires = new Date(now.getTime() + s.presence_response_minutes * 60_000);
      const row = (await q.query(
        `insert into presence_checks (employee_id, work_date, asked_at, expires_at) values ($1,$2,$3,$4) returning id`,
        [user.id, date, now, expires])).rows[0];
      return { id: row.id as string, askedAt: now, expiresAt: expires };
    });
  }

  /** The answer: the person's location against their own work location. */
  async respond(user: AuthUser, id: string, input: PresenceInput, now: Date = new Date(), onChange?: (q: Queryable, date: string) => Promise<void>) {
    const s = await this.settings.get();
    return this.db.tx(async (q) => {
      await q.query('select pg_advisory_xact_lock(hashtext($1))', [`presence:${user.id}`]);
      const row = (await q.query('select * from presence_checks where id = $1 and employee_id = $2 for update', [id, user.id])).rows[0];
      if (!row) throw notFound('NOT_FOUND', 'This check was not found');
      if (row.status !== 'pending') throw conflict('ALREADY_ANSWERED', row.status === 'missed' ? 'This check has run out of time' : 'This check is already answered');
      if (row.expires_at <= now) {
        await q.query(`update presence_checks set status = 'missed' where id = $1`, [id]);
        if (onChange) await onChange(q, row.work_date);
        throw conflict('EXPIRED', 'This check has run out of time');
      }

      // On approved on-duty work the person is not expected at the office: this is only a confirmation,
      // and their location is kept against the duty.
      const duty = (await q.query(
        `select 1 from od_requests where employee_id = $1 and kind = 'od' and status = 'approved' and from_date <= $2 and to_date >= $2 limit 1`, [user.id, row.work_date])).rows[0];
      if (duty) {
        await q.query(
          `update presence_checks set status = 'ok', answered_at = $2, latitude = $3, longitude = $4, accuracy_m = $5 where id = $1`,
          [id, now, input.latitude, input.longitude, input.accuracyM ?? null]);
        return { status: 'ok' as 'ok' | 'outside', distanceM: null as number | null };
      }

      const fences: Fence[] = (await q.query('select id, name, latitude, longitude, radius_m from geofences where active')).rows
        .map((f) => ({ id: f.id, name: f.name, latitude: f.latitude, longitude: f.longitude, radiusM: f.radius_m }));
      const emp = (await q.query('select work_location_id from employees where id = $1', [user.id])).rows[0];
      const own = emp?.work_location_id ? fences.find((f) => f.id === emp.work_location_id) : undefined;
      const match = matchGeofence(input.latitude, input.longitude, own ? [own] : fences);

      // A poor fix that lands outside is not held against the person: they are asked to try again.
      if (match.within === false && input.accuracyM !== undefined && input.accuracyM > s.geofence_low_accuracy_m) {
        throw badRequest('GPS_TOO_INACCURATE',
          `Your location is only accurate to ${Math.round(input.accuracyM)} m. Move to an open area or near a window and try again`);
      }
      const target = own ?? fences.find((f) => f.id === match.fenceId);
      const distance = target ? Math.round(haversineMeters(input.latitude, input.longitude, target.latitude, target.longitude)) : null;
      const status = match.within === false ? 'outside' : 'ok';
      await q.query(
        `update presence_checks set status = $2, answered_at = $3, latitude = $4, longitude = $5, accuracy_m = $6, geofence_id = $7, distance_m = $8 where id = $1`,
        [id, status, now, input.latitude, input.longitude, input.accuracyM ?? null, match.fenceId, distance]);
      if (onChange) await onChange(q, row.work_date);
      return { status: status as 'ok' | 'outside', distanceM: distance };
    });
  }

  /** For HR: the checks of one day that came back outside the work location or were never answered. */
  async report(date: string, now: Date = new Date()) {
    const rows = await this.db.rows(
      `select c.id, c.status, c.asked_at, c.answered_at, c.distance_m, c.retry_of, e.full_name, e.emp_code
         from presence_checks c join employees e on e.id = c.employee_id
        where c.work_date = $1 and (c.status in ('outside','missed') or (c.status = 'pending' and c.expires_at <= $2))
        order by c.asked_at`, [date, now]);
    return rows.map((r) => ({
      id: r.id as string, employeeName: r.full_name as string, empCode: r.emp_code as string,
      // A check left open after its time counts as not answered.
      status: (r.status === 'pending' ? 'missed' : r.status) as 'outside' | 'missed',
      askedAt: r.asked_at as Date, distanceM: r.distance_m as number | null, secondAsk: !!r.retry_of,
    }));
  }
}
