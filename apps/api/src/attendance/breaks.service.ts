import { Injectable } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { istDate } from '../common/dates';
import { conflict } from '../common/errors';
import { SettingsService } from '../common/settings.service';
import { Db, Queryable } from '../db/db.service';
import { pairSessions } from './attendance-calc';

export type BreakKind = 'lunch' | 'other';

/** Minutes of a break, an unfinished one counting up to `until`. */
export const breakMinutes = (b: { started_at: Date; ended_at: Date | null }, until: Date) =>
  Math.max(0, Math.round(((b.ended_at ?? until).getTime() - b.started_at.getTime()) / 60_000));

/**
 * Stepping out during the day, for lunch or something else. Time is the server's. A break does not
 * stop the working day: break time is working time, there is no fixed break and no limit. It is recorded
 * so there is a trail. Random location checks are paused while someone is on a break.
 */
@Injectable()
export class BreaksService {
  constructor(private readonly db: Db, private readonly settings: SettingsService) {}

  async state(user: { id: string }, now: Date = new Date(), q: Queryable = this.db) {
    const date = istDate(now);
    const rows = (await q.query(
      `select id, kind, note, started_at, ended_at from work_breaks where employee_id = $1 and work_date = $2 order by started_at`, [user.id, date])).rows;
    const open = rows.find((b) => !b.ended_at);
    return {
      usedMinutes: rows.reduce((n, b) => n + breakMinutes(b, now), 0),
      onBreak: open ? { id: open.id as string, kind: open.kind as BreakKind, since: open.started_at as Date } : null,
      breaks: rows.map((b) => ({
        id: b.id as string, kind: b.kind as BreakKind, note: b.note as string | null,
        startedAt: b.started_at as Date, endedAt: b.ended_at as Date | null, minutes: breakMinutes(b, now),
      })),
    };
  }

  async start(user: AuthUser, input: { kind: BreakKind; note?: string }, now: Date = new Date()) {
    await this.db.tx(async (q) => {
      await q.query('select pg_advisory_xact_lock(hashtext($1))', [`punch:${user.id}`]);
      const date = istDate(now);
      const events = (await q.query(
        `select event_type, event_at, flags from attendance_events where employee_id = $1 and work_date = $2 order by event_at`, [user.id, date])).rows;
      if (!pairSessions(events.map((e) => ({ type: e.event_type, at: e.event_at, flags: e.flags }))).openSince) {
        throw conflict('NOT_CHECKED_IN', 'Check in first. A break is taken during your working day');
      }
      const open = (await q.query('select 1 from work_breaks where employee_id = $1 and ended_at is null', [user.id])).rows[0];
      if (open) throw conflict('ALREADY_ON_BREAK', 'You are already on a break. End it when you are back');
      await q.query(
        `insert into work_breaks (employee_id, work_date, kind, note, started_at) values ($1,$2,$3,$4,$5)`,
        [user.id, date, input.kind, input.note?.trim() || null, now]);
    });
    return this.state(user, now);
  }

  async end(user: AuthUser, now: Date = new Date()) {
    const row = (await this.db.query(
      `update work_breaks set ended_at = $2 where employee_id = $1 and ended_at is null returning id`, [user.id, now])).rows[0];
    if (!row) throw conflict('NOT_ON_BREAK', 'You are not on a break');
    return this.state(user, now);
  }

  /** Closes a break left open (used when the person checks out). */
  async closeOpen(q: Queryable, employeeId: string, now: Date) {
    await q.query('update work_breaks set ended_at = $2 where employee_id = $1 and ended_at is null', [employeeId, now]);
  }
}
