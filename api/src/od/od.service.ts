import { Injectable, OnModuleInit } from '@nestjs/common';
import { ApprovalsService } from '../approvals/approvals.service';
import { ApprovalRequestRow } from '../approvals/approvals.types';
import { AuditService } from '../common/audit.service';
import { AuthUser, hasRole } from '../common/auth.types';
import { DayRecalc } from '../common/day-recalc.service';
import { addDays, dayOfWeek, eachDate, hhmm, istMinutes, minutesOf, monthRange, prettyDate, todayIst } from '../common/dates';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { SettingsService } from '../common/settings.service';
import { Db, Queryable } from '../db/db.service';
import { EmployeesService } from '../employees/employees.service';

export type OdKind = 'od' | 'permission';

export interface ApplyOdInput {
  kind: OdKind;
  fromDate: string;
  toDate: string;
  fromTime?: string;
  toTime?: string;
  location?: string;
  purpose: string;
}

const REQUEST_SQL = `
  select o.*, e.full_name as employee_name, e.emp_code
    from od_requests o join employees e on e.id = o.employee_id`;

/**
 * On-duty (OD) is work done away from the office for one or more days; a permission is a short
 * absence within a working day, capped in length and in number per month. Neither touches a leave
 * balance — approval only changes how the attendance days are shown.
 */
@Injectable()
export class OdService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly approvals: ApprovalsService,
    private readonly recalc: DayRecalc,
    private readonly employees: EmployeesService,
  ) {}

  onModuleInit() {
    for (const type of ['od', 'permission'] as const) {
      this.approvals.registerHandler(type, {
        onApproved: (q, req) => this.onApproved(q, req),
        onRejected: (q, req) => this.onRejected(q, req),
      });
    }
  }

  // ------------------------------------------------------------------ apply

  async apply(user: AuthUser, input: ApplyOdInput) {
    const s = await this.settings.get();
    const today = todayIst();

    if (input.toDate < input.fromDate) throw badRequest('BAD_DATES', 'The end date is before the start date');
    if (input.fromDate < addDays(today, -s.leave_backdate_days)) {
      throw badRequest('TOO_OLD', `Requests can be raised up to ${s.leave_backdate_days} days after the fact. Please contact HR`);
    }
    if (input.fromDate > addDays(today, 365)) throw badRequest('TOO_FAR_AHEAD', 'That date is too far ahead');
    if (input.kind === 'od' && eachDate(input.fromDate, input.toDate).length > 31) {
      throw badRequest('TOO_LONG', 'An on-duty request can cover at most 31 days. Please split it');
    }

    const holidayRows = await this.db.rows(
      `select holiday_date::text as d from holidays where holiday_date between $1 and $2 and not optional`, [input.fromDate, input.toDate]);
    const holidays = new Set(holidayRows.map((h) => h.d as string));
    const working = eachDate(input.fromDate, input.toDate).filter((d) => !holidays.has(d) && !s.weekly_off_days.includes(dayOfWeek(d)));

    let minutes = 0;
    if (input.kind === 'permission') {
      if (input.fromDate !== input.toDate) throw badRequest('PERMISSION_SINGLE_DAY', 'A permission covers a single date');
      if (!input.fromTime || !input.toTime) throw badRequest('TIMES_REQUIRED', 'Please give the start and end time');
      minutes = minutesOf(input.toTime) - minutesOf(input.fromTime);
      if (minutes <= 0) throw badRequest('BAD_TIMES', 'The end time must be after the start time');
      if (minutes > s.permission_max_minutes) {
        throw badRequest('PERMISSION_TOO_LONG', `A permission can be at most ${s.permission_max_minutes} minutes. Please apply for leave instead`);
      }
      if (!working.length) throw badRequest('NOT_A_WORKING_DAY', 'That date is a holiday or weekly off');
    } else if (!working.length) {
      throw badRequest('NO_WORKING_DAYS', 'Those dates are all holidays or weekly offs');
    }

    const id = await this.db.tx(async (q) => {
      await q.query('select pg_advisory_xact_lock(hashtext($1))', [`od-apply:${user.id}`]);

      const leave = await q.query(
        `select 1 from leave_requests where employee_id = $1 and status in ('pending','approved')
            and from_date <= $3 and to_date >= $2 limit 1`, [user.id, input.fromDate, input.toDate]);
      if (leave.rowCount) throw conflict('LEAVE_CONFLICT', 'You have leave applied on some of these dates');

      if (input.kind === 'od') {
        const clash = await q.query(
          `select 1 from od_requests where employee_id = $1 and kind = 'od' and status in ('pending','approved')
              and from_date <= $3 and to_date >= $2 limit 1`, [user.id, input.fromDate, input.toDate]);
        if (clash.rowCount) throw conflict('OVERLAP', 'You already have an on-duty request on some of these dates');
      } else {
        const od = await q.query(
          `select 1 from od_requests where employee_id = $1 and kind = 'od' and status in ('pending','approved')
              and from_date <= $2 and to_date >= $2 limit 1`, [user.id, input.fromDate]);
        if (od.rowCount) throw conflict('OD_CONFLICT', 'You have an on-duty request covering that date');
        const clash = await q.query(
          `select 1 from od_requests where employee_id = $1 and kind = 'permission' and status in ('pending','approved')
              and from_date = $2 and from_time < $4::time and to_time > $3::time limit 1`,
          [user.id, input.fromDate, input.fromTime, input.toTime]);
        if (clash.rowCount) throw conflict('OVERLAP', 'You already have a permission at that time');

        const quota = await this.quotaFor(q, user.id, input.fromDate.slice(0, 7), s.permission_monthly_limit, s.permission_max_minutes);
        if (quota.used >= quota.limit) {
          throw conflict('PERMISSION_LIMIT', `You have already used ${quota.used} of ${quota.limit} permissions for this month`, { used: quota.used, limit: quota.limit });
        }
      }

      const req = (await q.query(
        `insert into od_requests (employee_id, kind, from_date, to_date, from_time, to_time, location, purpose)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [user.id, input.kind, input.fromDate, input.toDate, input.fromTime ?? null, input.toTime ?? null, input.location ?? null, input.purpose])).rows[0];

      const summary = input.kind === 'od'
        ? `On duty: ${prettyDate(input.fromDate)}${input.toDate !== input.fromDate ? ` to ${prettyDate(input.toDate)}` : ''}` +
          ` — ${user.fullName} (${input.purpose}${input.location ? `, ${input.location}` : ''})`
        : `Permission: ${prettyDate(input.fromDate)}, ${input.fromTime}–${input.toTime} (${minutes} min) — ${user.fullName} (${input.purpose})`;
      const approvalId = await this.approvals.submit(q, { type: input.kind, refId: req.id, requesterId: user.id, summary, size: 1 });
      await q.query('update od_requests set approval_request_id = $2 where id = $1', [req.id, approvalId]);
      await this.audit.record({ actorId: user.id, action: `${input.kind}.apply`, entityType: 'od_request', entityId: req.id, after: input }, q);
      return req.id as string;
    });
    return this.getOne(id);
  }

  /** How many permissions this person has used in a month, against the monthly limit. */
  async quota(user: AuthUser, month: string) {
    const s = await this.settings.get();
    return this.quotaFor(this.db, user.id, month, s.permission_monthly_limit, s.permission_max_minutes);
  }

  private async quotaFor(q: Queryable, employeeId: string, month: string, limit: number, maxMinutes: number) {
    const [from, to] = monthRange(month);
    const used = (await q.query(
      `select count(*)::int as n from od_requests where employee_id = $1 and kind = 'permission'
          and status in ('pending','approved') and from_date between $2 and $3`, [employeeId, from, to])).rows[0].n as number;
    return { month, used, limit, remaining: Math.max(limit - used, 0), maxMinutes };
  }

  // ----------------------------------------------------------------- cancel

  async cancel(user: AuthUser, id: string) {
    await this.db.tx(async (q) => {
      // Approval first, then the request: the same lock order a decision takes.
      const pre = (await q.query('select approval_request_id from od_requests where id = $1', [id])).rows[0];
      if (!pre) throw notFound('OD_NOT_FOUND', 'Request not found');
      if (pre.approval_request_id) await q.query('select 1 from approval_requests where id = $1 for update', [pre.approval_request_id]);
      const row = (await q.query('select * from od_requests where id = $1 for update', [id])).rows[0];
      const isHr = hasRole(user, 'hr_admin');
      if (row.employee_id !== user.id && !isHr) throw forbidden('FORBIDDEN', 'You can only cancel your own requests');

      if (row.status === 'pending') {
        await this.approvals.cancelPending(q, row.approval_request_id, user.id);
      } else if (row.status === 'approved') {
        if (!isHr && this.hasStarted(row)) {
          throw conflict('ALREADY_STARTED', 'This has already started and can only be cancelled by HR');
        }
        await this.approvals.cancelApproved(q, row.approval_request_id, user.id);
        await this.recalc.run(q, row.employee_id, row.from_date, row.to_date);
      } else {
        throw conflict('NOT_CANCELLABLE', `This request is already ${row.status}`);
      }
      await q.query(`update od_requests set status = 'cancelled', updated_at = now() where id = $1`, [id]);
      await this.audit.record({ actorId: user.id, action: `${row.kind}.cancel`, entityType: 'od_request', entityId: id, before: { status: row.status } }, q);
    });
    return this.getOne(id);
  }

  private hasStarted(row: { kind: OdKind; from_date: string; from_time: string | null }, now: Date = new Date()): boolean {
    const today = todayIst(now);
    if (row.from_date < today) return true;
    if (row.from_date > today) return false;
    return row.kind === 'od' ? true : istMinutes(now) >= minutesOf(row.from_time ?? '00:00');
  }

  // -------------------------------------------------------- approval hooks

  private async onApproved(q: Queryable, req: ApprovalRequestRow) {
    const row = (await q.query(`update od_requests set status = 'approved', updated_at = now() where id = $1 returning *`, [req.refId])).rows[0];
    await this.recalc.run(q, row.employee_id, row.from_date, row.to_date);
  }

  private async onRejected(q: Queryable, req: ApprovalRequestRow) {
    await q.query(`update od_requests set status = 'rejected', updated_at = now() where id = $1`, [req.refId]);
  }

  // ------------------------------------------------------------------ reads

  async getOne(id: string) {
    const row = await this.db.one(`${REQUEST_SQL} where o.id = $1`, [id]);
    if (!row) throw notFound('OD_NOT_FOUND', 'Request not found');
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

  async mine(user: AuthUser, filter: { from?: string; to?: string; kind?: OdKind }) {
    const from = filter.from ?? addDays(todayIst(), -90);
    const rows = await this.db.rows(
      `${REQUEST_SQL}
        where o.employee_id = $1 and o.to_date >= $2 and ($3::date is null or o.from_date <= $3) and ($4::text is null or o.kind = $4)
        order by o.from_date desc, o.created_at desc`,
      [user.id, from, filter.to ?? null, filter.kind ?? null]);
    return this.withApproval(rows);
  }

  async team(user: AuthUser, filter: { status?: string; kind?: OdKind; from?: string; to?: string }) {
    const scope = await this.employees.teamScope(user);
    if (scope && !scope.length) return [];
    const rows = await this.db.rows(
      `${REQUEST_SQL}
        where ($1::uuid[] is null or o.employee_id = any($1))
          and ($2::text is null or o.status = $2) and ($3::text is null or o.kind = $3)
          and ($4::date is null or o.to_date >= $4) and ($5::date is null or o.from_date <= $5)
        order by o.from_date desc limit 300`,
      [scope, filter.status ?? null, filter.kind ?? null, filter.from ?? null, filter.to ?? null]);
    return this.withApproval(rows);
  }

  private async withApproval(rows: any[]) {
    const summaries = await this.approvals.summaries(rows.map((r) => r.approval_request_id).filter(Boolean));
    return rows.map((r) => {
      const a = summaries.get(r.approval_request_id);
      return {
        id: r.id as string, kind: r.kind as OdKind, employeeId: r.employee_id as string, employeeName: r.employee_name as string,
        empCode: r.emp_code as string, fromDate: r.from_date as string, toDate: r.to_date as string,
        fromTime: r.from_time ? hhmm(r.from_time) : null, toTime: r.to_time ? hhmm(r.to_time) : null,
        minutes: r.from_time && r.to_time ? minutesOf(r.to_time) - minutesOf(r.from_time) : null,
        location: r.location as string | null, purpose: r.purpose as string, status: r.status as string,
        approvalRequestId: r.approval_request_id as string | null,
        currentApprover: a?.currentApprover ?? null, lastComment: a?.lastComment ?? null, createdAt: r.created_at as Date,
      };
    });
  }
}
