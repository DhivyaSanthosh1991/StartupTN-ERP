import { Injectable, OnModuleInit } from '@nestjs/common';
import { ApprovalsService } from '../approvals/approvals.service';
import { ApprovalRequestRow } from '../approvals/approvals.types';
import { haversineMeters } from '../attendance/attendance-calc';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth.types';
import { hhmm, istMinutes, minutesOf, todayIst } from '../common/dates';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { SettingsService } from '../common/settings.service';
import { Db, Queryable } from '../db/db.service';

/** Straight-line distance understates the road: this allowance and an average city speed give the estimate. */
export const ROAD_FACTOR = 1.3;
export const AVERAGE_SPEED_KMH = 25;
/** Going home directly is suggested when the office would be reached less than this long before it closes. */
export const NOT_WORTH_RETURNING_MINUTES = 30;

const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** How long the trip from where the duty ended to the office would take, and whether it is worth making. */
export function estimateReturn(distanceM: number, leftAtMinutes: number, officeEndMinutes: number) {
  const travelMinutes = Math.max(5, Math.round(((distanceM / 1000) * ROAD_FACTOR / AVERAGE_SPEED_KMH) * 60));
  const arriveMinutes = leftAtMinutes + travelMinutes;
  return {
    distanceKm: Math.round(distanceM / 100) / 10,
    travelMinutes,
    arriveAt: clock(arriveMinutes),
    officeEnd: clock(officeEndMinutes),
    suggested: arriveMinutes > officeEndMinutes - NOT_WORTH_RETURNING_MINUTES,
  };
}

/**
 * After an on-duty day's work, a person either goes back to the office or asks to go straight home.
 * The second needs approval: the request carries when they left the site and how long the way back to
 * the office would take, so the approver can see why.
 */
@Injectable()
export class OdHomeService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly approvals: ApprovalsService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler('od_home', {
      onApproved: async (q, req) => { await this.setStatus(q, req, 'approved'); },
      onRejected: async (q, req) => { await this.setStatus(q, req, 'rejected'); },
    });
  }

  private setStatus(q: Queryable, req: ApprovalRequestRow, status: string) {
    return q.query(`update od_home_requests set status = $2, updated_at = now() where id = $1`, [req.refId, status]);
  }

  /** Where today's on-duty work stands, and what can be done next. */
  async today(user: AuthUser, now: Date = new Date()) {
    const s = await this.settings.get();
    const date = todayIst(now);
    const duty = await this.db.one(
      `select id, location, purpose from od_requests where employee_id = $1 and kind = 'od' and status = 'approved' and from_date <= $2 and to_date >= $2 limit 1`,
      [user.id, date]);
    if (!duty) return { onDuty: false as const };

    const last = await this.db.one(
      `select event_type, event_at, latitude, longitude from attendance_events
        where employee_id = $1 and work_date = $2 and not ('superseded' = any(flags)) order by event_at desc limit 1`, [user.id, date]);
    const ownOffice = await this.db.one(
      `select g.name, g.latitude, g.longitude, g.radius_m from employees e join geofences g on g.id = e.work_location_id where e.id = $1 and g.active`, [user.id]);
    // The last punch decides: still at a place, finished somewhere, or back in the office.
    const atOffice = !!last && !!ownOffice && last.latitude !== null &&
      haversineMeters(last.latitude, last.longitude, ownOffice.latitude, ownOffice.longitude) <= ownOffice.radius_m;
    const stops = await this.db.rows(
      `select id, location, purpose, meeting_time, created_at from od_stops where employee_id = $1 and work_date = $2 order by created_at`, [user.id, date]);
    const pendingStop = last && last.event_type === 'check_out' && !atOffice
      ? stops.find((x) => x.created_at > last.event_at) : undefined;
    const state = !last ? 'not_started'
      : last.event_type === 'check_in' ? (atOffice ? 'at_office' : 'on_site')
      : atOffice ? 'at_office' : pendingStop ? 'next_stop' : 'finished';

    const request = await this.db.one(
      `select * from od_home_requests where employee_id = $1 and work_date = $2 order by created_at desc limit 1`, [user.id, date]);

    let estimate: ReturnType<typeof estimateReturn> | null = null;
    let officeName: string | null = null;
    if (state === 'finished' && last.latitude !== null) {
      const office = ownOffice;
      if (office) {
        officeName = office.name;
        estimate = estimateReturn(
          haversineMeters(last.latitude, last.longitude, office.latitude, office.longitude),
          minutesOf(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(last.event_at)),
          minutesOf(s.work_start) + s.full_day_minutes);
      }
    }
    return {
      onDuty: true as const,
      duty: { id: duty.id as string, location: duty.location as string | null, purpose: duty.purpose as string },
      state: state as 'not_started' | 'on_site' | 'finished' | 'next_stop' | 'at_office',
      stops: stops.map((x) => ({
        id: x.id as string, location: x.location as string, purpose: x.purpose as string | null,
        meetingTime: x.meeting_time ? hhmm(x.meeting_time) : null, current: pendingStop?.id === x.id,
      })),
      leftSiteAt: state === 'finished' ? (last.event_at as Date) : null,
      officeName,
      estimate,
      request: request ? (await this.view([request]))[0] : null,
    };
  }

  /**
   * Another meeting the same day, somewhere else. Allowed once the work at the current place is finished;
   * the next check-in is then recorded against the new place. A reporting time may be given.
   */
  async addStop(user: AuthUser, input: { location: string; purpose?: string; meetingTime?: string }, now: Date = new Date()) {
    const status = await this.today(user, now);
    if (!status.onDuty) throw conflict('NO_DUTY_TODAY', 'You have no approved on-duty work today');
    if (status.state === 'on_site') throw conflict('DUTY_NOT_FINISHED', 'Check out from the current place first, then add the next meeting');
    if (status.state === 'next_stop') throw conflict('STOP_ALREADY_ADDED', 'The next meeting is already added. Check in there when you arrive');
    if (status.request && ['pending', 'approved'].includes(status.request.status)) {
      throw conflict('ALREADY_ASKED', 'You have asked to go home. Withdraw that request first if you now have another meeting');
    }
    const id = await this.db.tx(async (q) => {
      const row = (await q.query(
        `insert into od_stops (od_request_id, employee_id, work_date, location, purpose, meeting_time, created_at)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [status.duty.id, user.id, todayIst(now), input.location.trim(), input.purpose?.trim() || null, input.meetingTime ?? null, now])).rows[0];
      await this.audit.record({ actorId: user.id, action: 'od.stop_add', entityType: 'od_stop', entityId: row.id, after: input }, q);
      return row.id as string;
    });
    void id;
    return this.today(user, now);
  }

  async apply(user: AuthUser, input: { reason?: string }, now: Date = new Date()) {
    const status = await this.today(user, now);
    if (!status.onDuty) throw conflict('NO_DUTY_TODAY', 'You have no approved on-duty work today');
    if (status.state !== 'finished') {
      throw conflict('DUTY_NOT_FINISHED', status.state === 'on_site'
        ? 'Check out from the duty location first, then ask to go home'
        : status.state === 'next_stop' ? 'You have another meeting lined up. Check in there, or remove it by finishing it first'
        : status.state === 'at_office' ? 'You are back at the office, so there is nothing to approve. Check out when your day is done'
        : 'Check in at the duty location and check out when the work is done, then ask to go home');
    }
    const last = (await this.db.one(
      `select latitude, longitude from attendance_events where employee_id = $1 and work_date = $2 and event_type = 'check_out'
        and not ('superseded' = any(flags)) order by event_at desc limit 1`, [user.id, todayIst(now)]))!;

    try {
      const id = await this.db.tx(async (q) => {
        const row = (await q.query(
          `insert into od_home_requests (employee_id, od_request_id, work_date, left_site_at, from_latitude, from_longitude,
                                         distance_to_office_m, travel_minutes, reason)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
          [user.id, status.duty.id, todayIst(now), status.leftSiteAt, last.latitude, last.longitude,
           status.estimate ? Math.round(status.estimate.distanceKm * 1000) : null, status.estimate?.travelMinutes ?? null,
           input.reason?.trim() || null])).rows[0];
        const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(status.leftSiteAt!);
        const summary = `Going home after duty at ${status.duty.location ?? 'the duty location'} — ${user.fullName}. Left the site at ${hhmm}` +
          (status.estimate ? `; the office is about ${status.estimate.travelMinutes} min away (would arrive ${status.estimate.arriveAt}, office closes ${status.estimate.officeEnd})` : '') +
          (input.reason?.trim() ? `. ${input.reason.trim()}` : '');
        const approvalId = await this.approvals.submit(q, { type: 'od_home', refId: row.id, requesterId: user.id, summary, size: 1 });
        await q.query('update od_home_requests set approval_request_id = $2 where id = $1', [row.id, approvalId]);
        await this.audit.record({ actorId: user.id, action: 'od_home.apply', entityType: 'od_home_request', entityId: row.id, after: { reason: input.reason ?? null } }, q);
        return row.id as string;
      });
      return (await this.view([(await this.db.one('select * from od_home_requests where id = $1', [id]))!]))[0];
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('ALREADY_ASKED', 'You have already asked to go home today');
      throw err;
    }
  }

  async cancel(user: AuthUser, id: string) {
    await this.db.tx(async (q) => {
      const row = (await q.query('select * from od_home_requests where id = $1 for update', [id])).rows[0];
      if (!row) throw notFound('NOT_FOUND', 'Request not found');
      if (row.employee_id !== user.id) throw forbidden('FORBIDDEN', 'You can only cancel your own request');
      if (row.status !== 'pending') throw badRequest('NOT_PENDING', `This request is already ${row.status}`);
      await this.approvals.cancelPending(q, row.approval_request_id, user.id);
      await q.query(`update od_home_requests set status = 'cancelled', updated_at = now() where id = $1`, [id]);
    });
    return (await this.view([(await this.db.one('select * from od_home_requests where id = $1', [id]))!]))[0];
  }

  private async view(rows: any[]) {
    const summaries = await this.approvals.summaries(rows.map((r) => r.approval_request_id).filter(Boolean));
    return rows.map((r) => {
      const a = summaries.get(r.approval_request_id);
      return {
        id: r.id as string, status: r.status as string, reason: r.reason as string | null, workDate: r.work_date as string,
        leftSiteAt: r.left_site_at as Date, travelMinutes: r.travel_minutes as number | null,
        approvalRequestId: r.approval_request_id as string | null, currentApprover: a?.currentApprover ?? null, lastComment: a?.lastComment ?? null,
      };
    });
  }
}
