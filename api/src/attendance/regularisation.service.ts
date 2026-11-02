import { Injectable, OnModuleInit } from '@nestjs/common';
import { ApprovalsService } from '../approvals/approvals.service';
import { ApprovalRequestRow } from '../approvals/approvals.types';
import { AuditService } from '../common/audit.service';
import { AuthUser, hasRole } from '../common/auth.types';
import { DayRecalc } from '../common/day-recalc.service';
import { addDays, hhmm, istInstant, minutesOf, prettyDate, todayIst } from '../common/dates';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { SettingsService } from '../common/settings.service';
import { Db, Queryable } from '../db/db.service';
import { EmployeesService } from '../employees/employees.service';
import { PunchEvent, pairSessions } from './attendance-calc';

export interface ApplyRegularisationInput {
  workDate: string;
  checkInTime?: string;
  checkOutTime?: string;
  reason: string;
}

const REQUEST_SQL = `
  select r.*, e.full_name as employee_name, e.emp_code
    from regularisation_requests r join employees e on e.id = r.employee_id`;

/**
 * Corrections for a missed or wrong punch. Once approved, the times become punches of their own
 * (marked as corrections, with no GPS), so the original location record is never altered.
 */
@Injectable()
export class RegularisationService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly approvals: ApprovalsService,
    private readonly recalc: DayRecalc,
    private readonly employees: EmployeesService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler('regularisation', {
      onApproved: (q, req) => this.onApproved(q, req),
      onRejected: (q, req) => this.onRejected(q, req),
    });
  }

  async apply(user: AuthUser, input: ApplyRegularisationInput, now: Date = new Date()) {
    const s = await this.settings.get();
    const today = todayIst(now);
    if (!input.checkInTime && !input.checkOutTime) throw badRequest('TIMES_REQUIRED', 'Give the check-in time, the check-out time, or both');
    if (input.checkInTime && input.checkOutTime && minutesOf(input.checkOutTime) <= minutesOf(input.checkInTime)) {
      throw badRequest('BAD_TIMES', 'The check-out time must be after the check-in time');
    }
    if (input.workDate > today) throw badRequest('FUTURE_DATE', 'Corrections are for days that have already begun');
    if (input.workDate < addDays(today, -s.regularisation_window_days)) {
      throw badRequest('TOO_OLD', `Corrections can be raised up to ${s.regularisation_window_days} days after the day. Please contact HR`);
    }
    for (const t of [input.checkInTime, input.checkOutTime]) {
      if (t && istInstant(input.workDate, t).getTime() > now.getTime()) throw badRequest('FUTURE_TIME', 'That time has not happened yet');
    }
    if (s.attendance_start_date && input.workDate < s.attendance_start_date) {
      throw badRequest('BEFORE_ATTENDANCE_START', `Attendance is tracked from ${prettyDate(s.attendance_start_date)}, so earlier days cannot be corrected`);
    }
    const emp = await this.db.one('select date_of_joining, exit_date from employees where id = $1', [user.id]);
    if ((emp!.date_of_joining && input.workDate < emp!.date_of_joining) || (emp!.exit_date && input.workDate > emp!.exit_date)) {
      throw badRequest('NOT_EMPLOYED', 'You were not employed on that date');
    }

    const id = await this.db.tx(async (q) => {
      await q.query('select pg_advisory_xact_lock(hashtext($1))', [`reg-apply:${user.id}`]);

      const pending = await q.query(
        `select 1 from regularisation_requests where employee_id = $1 and work_date = $2 and status = 'pending' limit 1`, [user.id, input.workDate]);
      if (pending.rowCount) throw conflict('ALREADY_PENDING', 'You already have a correction waiting for approval on that date');

      const covered = await q.query(
        `select 1 from leave_requests where employee_id = $1 and day_part = 'full' and status in ('pending','approved') and from_date <= $2 and to_date >= $2
         union all
         select 1 from od_requests where employee_id = $1 and kind = 'od' and status in ('pending','approved') and from_date <= $2 and to_date >= $2 limit 1`,
        [user.id, input.workDate]);
      if (covered.rowCount) throw conflict('DAY_COVERED', 'That day is covered by leave or an on-duty request, so there is nothing to correct');

      // A single time must complete a session with what was punched (close an open check-in, or match an orphan check-out); otherwise ask for both.
      if (!(input.checkInTime && input.checkOutTime)) {
        const existing = await this.liveEvents(q, user.id, input.workDate);
        const added: PunchEvent = input.checkInTime
          ? { type: 'check_in', at: istInstant(input.workDate, input.checkInTime), flags: [] }
          : { type: 'check_out', at: istInstant(input.workDate, input.checkOutTime!), flags: [] };
        const before = pairSessions(existing);
        const after = pairSessions([...existing, added]);
        if (after.minutes <= before.minutes) {
          throw badRequest('CORRECTION_NO_EFFECT',
            'That time does not fit with the punches already recorded for the day. Please give both the check-in and check-out time');
        }
      }

      const req = (await q.query(
        `insert into regularisation_requests (employee_id, work_date, check_in_time, check_out_time, reason)
         values ($1,$2,$3,$4,$5) returning id`,
        [user.id, input.workDate, input.checkInTime ?? null, input.checkOutTime ?? null, input.reason])).rows[0];

      const times = [input.checkInTime && `in ${input.checkInTime}`, input.checkOutTime && `out ${input.checkOutTime}`].filter(Boolean).join(', ');
      const summary = `Attendance correction: ${prettyDate(input.workDate)}, ${times} — ${user.fullName} (${input.reason})`;
      const approvalId = await this.approvals.submit(q, { type: 'regularisation', refId: req.id, requesterId: user.id, summary });
      await q.query('update regularisation_requests set approval_request_id = $2 where id = $1', [req.id, approvalId]);
      await this.audit.record({ actorId: user.id, action: 'regularisation.apply', entityType: 'regularisation_request', entityId: req.id, after: input }, q);
      return req.id as string;
    });
    return this.getOne(id);
  }

  async cancel(user: AuthUser, id: string) {
    await this.db.tx(async (q) => {
      const pre = (await q.query('select approval_request_id from regularisation_requests where id = $1', [id])).rows[0];
      if (!pre) throw notFound('REGULARISATION_NOT_FOUND', 'Request not found');
      if (pre.approval_request_id) await q.query('select 1 from approval_requests where id = $1 for update', [pre.approval_request_id]);
      const row = (await q.query('select * from regularisation_requests where id = $1 for update', [id])).rows[0];
      if (row.employee_id !== user.id && !hasRole(user, 'hr_admin')) throw forbidden('FORBIDDEN', 'You can only cancel your own requests');
      if (row.status !== 'pending') {
        throw conflict('NOT_CANCELLABLE', row.status === 'approved'
          ? 'This correction has already been applied. Please ask HR if it needs to be changed' : `This request is already ${row.status}`);
      }
      await this.approvals.cancelPending(q, row.approval_request_id, user.id);
      await q.query(`update regularisation_requests set status = 'cancelled', updated_at = now() where id = $1`, [id]);
      await this.audit.record({ actorId: user.id, action: 'regularisation.cancel', entityType: 'regularisation_request', entityId: id }, q);
    });
    return this.getOne(id);
  }

  private async liveEvents(q: Queryable, employeeId: string, date: string): Promise<PunchEvent[]> {
    const rows = (await q.query(
      `select event_type, event_at, flags from attendance_events where employee_id = $1 and work_date = $2 and not ('superseded' = any(flags))`,
      [employeeId, date])).rows;
    return rows.map((r) => ({ type: r.event_type, at: r.event_at, flags: r.flags }));
  }

  // -------------------------------------------------------- approval hooks

  private async onApproved(q: Queryable, req: ApprovalRequestRow) {
    const row = (await q.query('select * from regularisation_requests where id = $1 for update', [req.refId])).rows[0];
    // Giving both times replaces the day's punches (kept for the record, but set aside); a single time adds to them.
    if (row.check_in_time && row.check_out_time) {
      await q.query(
        `update attendance_events set flags = array_append(flags, 'superseded')
          where employee_id = $1 and work_date = $2 and not ('superseded' = any(flags))`, [row.employee_id, row.work_date]);
    }
    for (const [type, time] of [['check_in', row.check_in_time], ['check_out', row.check_out_time]] as const) {
      if (!time) continue;
      await q.query(
        `insert into attendance_events (employee_id, event_type, event_at, work_date, flags, source, note)
         values ($1,$2,$3,$4,array['regularised'],'regularisation',$5)`,
        [row.employee_id, type, istInstant(row.work_date, hhmm(time)), row.work_date, row.reason]);
    }
    await q.query(`update regularisation_requests set status = 'approved', updated_at = now() where id = $1`, [row.id]);
    await this.recalc.run(q, row.employee_id, row.work_date, row.work_date);
  }

  private async onRejected(q: Queryable, req: ApprovalRequestRow) {
    await q.query(`update regularisation_requests set status = 'rejected', updated_at = now() where id = $1`, [req.refId]);
  }

  // ------------------------------------------------------------------ reads

  async getOne(id: string) {
    const row = await this.db.one(`${REQUEST_SQL} where r.id = $1`, [id]);
    if (!row) throw notFound('REGULARISATION_NOT_FOUND', 'Request not found');
    return (await this.withApproval([row]))[0];
  }

  async getForViewer(viewer: AuthUser, id: string) {
    const view = await this.getOne(id);
    if (view.employeeId !== viewer.id && !hasRole(viewer, 'hr_admin')) {
      const scope = await this.employees.teamScope(viewer);
      if (!scope?.includes(view.employeeId)) throw forbidden('FORBIDDEN', 'You do not have access to this request');
    }
    return view;
  }

  async mine(user: AuthUser) {
    const rows = await this.db.rows(`${REQUEST_SQL} where r.employee_id = $1 order by r.work_date desc, r.created_at desc limit 100`, [user.id]);
    return this.withApproval(rows);
  }

  async team(user: AuthUser, filter: { status?: string }) {
    const scope = await this.employees.teamScope(user);
    if (scope && !scope.length) return [];
    const rows = await this.db.rows(
      `${REQUEST_SQL}
        where ($1::uuid[] is null or r.employee_id = any($1)) and ($2::text is null or r.status = $2)
        order by r.work_date desc limit 300`, [scope, filter.status ?? null]);
    return this.withApproval(rows);
  }

  private async withApproval(rows: any[]) {
    const summaries = await this.approvals.summaries(rows.map((r) => r.approval_request_id).filter(Boolean));
    return rows.map((r) => {
      const a = summaries.get(r.approval_request_id);
      return {
        id: r.id as string, employeeId: r.employee_id as string, employeeName: r.employee_name as string, empCode: r.emp_code as string,
        workDate: r.work_date as string, checkInTime: r.check_in_time ? hhmm(r.check_in_time) : null,
        checkOutTime: r.check_out_time ? hhmm(r.check_out_time) : null, reason: r.reason as string, status: r.status as string,
        approvalRequestId: r.approval_request_id as string | null,
        currentApprover: a?.currentApprover ?? null, lastComment: a?.lastComment ?? null, createdAt: r.created_at as Date,
      };
    });
  }
}
