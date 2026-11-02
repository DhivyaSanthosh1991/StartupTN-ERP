import { Injectable, OnModuleInit } from '@nestjs/common';
import { ApprovalsService } from '../approvals/approvals.service';
import { ApprovalRequestRow } from '../approvals/approvals.types';
import { AuditService } from '../common/audit.service';
import { AuthUser, hasRole } from '../common/auth.types';
import { DayRecalc } from '../common/day-recalc.service';
import { addDays, leaveYearOf, prettyDate, todayIst } from '../common/dates';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { SettingsService } from '../common/settings.service';
import { Db, Queryable } from '../db/db.service';
import { EmployeesService } from '../employees/employees.service';
import { DayPart, countLeaveDays, leaveMonths, leaveYearBounds, monthlyAccrual, prorateUpfront } from './leave-calc';

export interface ApplyLeaveInput {
  leaveTypeId: string;
  fromDate: string;
  toDate: string;
  dayPart: DayPart;
  reason: string;
}

export interface LeaveTypeInput {
  code: string;
  name: string;
  annualEntitlement: number;
  accrual: 'upfront' | 'monthly';
  carryForwardMax: number;
  allowHalfDay: boolean;
  paid: boolean;
  applicableEmploymentTypes: string[];
  requiresDocumentAfterDays?: number | null;
  active: boolean;
  sortOrder: number;
}

const REQUEST_SQL = `
  select lr.*, lt.code as leave_type_code, lt.name as leave_type_name, lt.paid,
         e.full_name as employee_name, e.emp_code
    from leave_requests lr
    join leave_types lt on lt.id = lr.leave_type_id
    join employees e on e.id = lr.employee_id`;

@Injectable()
export class LeaveService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly approvals: ApprovalsService,
    private readonly recalc: DayRecalc,
    private readonly employees: EmployeesService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler('leave', {
      onApproved: (q, req) => this.onApproved(q, req),
      onRejected: (q, req) => this.onRejected(q, req),
    });
  }

  // ------------------------------------------------------------ leave types

  async typesFor(employeeId: string) {
    const emp = await this.db.one('select employment_type from employees where id = $1', [employeeId]);
    if (!emp) throw notFound('EMPLOYEE_NOT_FOUND', 'Employee not found');
    const rows = await this.db.rows(
      `select * from leave_types where active and applicable_employment_types @> array[$1]::text[] order by sort_order, name`,
      [emp.employment_type]);
    return rows.map(typeView);
  }

  async allTypes() {
    return (await this.db.rows('select * from leave_types order by sort_order, name')).map(typeView);
  }

  async createType(actor: AuthUser, input: LeaveTypeInput) {
    try {
      return await this.db.tx(async (q) => {
        const r = await q.query(
          `insert into leave_types (code, name, annual_entitlement, accrual, carry_forward_max, allow_half_day, paid,
                                    applicable_employment_types, requires_document_after_days, active, sort_order)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
          [input.code.toUpperCase(), input.name, input.annualEntitlement, input.accrual, input.carryForwardMax, input.allowHalfDay,
           input.paid, input.applicableEmploymentTypes, input.requiresDocumentAfterDays ?? null, input.active, input.sortOrder]);
        await this.audit.record({ actorId: actor.id, action: 'leave_type.create', entityType: 'leave_type', entityId: r.rows[0].id, after: input }, q);
        return typeView(r.rows[0]);
      });
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('LEAVE_TYPE_EXISTS', 'A leave type with this code already exists');
      throw err;
    }
  }

  async updateType(actor: AuthUser, id: string, patch: Partial<LeaveTypeInput>) {
    const before = await this.db.one('select * from leave_types where id = $1', [id]);
    if (!before) throw notFound('LEAVE_TYPE_NOT_FOUND', 'Leave type not found');
    const col: Record<string, string> = {
      name: 'name', annualEntitlement: 'annual_entitlement', accrual: 'accrual', carryForwardMax: 'carry_forward_max',
      allowHalfDay: 'allow_half_day', paid: 'paid', applicableEmploymentTypes: 'applicable_employment_types',
      requiresDocumentAfterDays: 'requires_document_after_days', active: 'active', sortOrder: 'sort_order',
    };
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
        await q.query(`update leave_types set ${sets.join(', ')} where id = $${values.length}`, values);
        await this.audit.record({ actorId: actor.id, action: 'leave_type.update', entityType: 'leave_type', entityId: id, before: typeView(before), after: patch }, q);
      });
    }
    return typeView((await this.db.one('select * from leave_types where id = $1', [id]))!);
  }

  // --------------------------------------------------------------- balances

  /**
   * Makes sure the ledger holds this employee's entitlement for the leave year: carry-forward from
   * the previous year, the up-front credit (prorated for joiners) and monthly accruals up to the
   * current month. Idempotent, so it is safe to call before every balance read.
   */
  async ensureEntitlements(q: Queryable, employeeId: string, year: number, now: Date = new Date()): Promise<void> {
    const s = await this.settings.get();
    const emp = (await q.query('select employment_type, date_of_joining from employees where id = $1', [employeeId])).rows[0];
    if (!emp) return;
    await this.lockYear(q, employeeId, year);

    // Nothing accrues for a leave year that ended before the person joined.
    if (this.joinedAfter(emp, year, s.leave_year_start_month)) return;

    const currentYear = leaveYearOf(todayIst(now), s.leave_year_start_month);
    const types = (await q.query(
      `select * from leave_types where active and annual_entitlement > 0 and applicable_employment_types @> array[$1]::text[]`,
      [emp.employment_type])).rows;

    for (const t of types) {
      if (year <= currentYear) await this.carryForward(q, employeeId, emp, t, year, s, now);
      await this.credit(q, employeeId, emp, t, year, s, now);
    }
  }

  private lockYear(q: Queryable, employeeId: string, year: number) {
    return q.query('select pg_advisory_xact_lock(hashtext($1))', [`leave-ledger:${employeeId}:${year}`]);
  }

  private joinedAfter(emp: any, year: number, startMonth: number): boolean {
    return !!emp.date_of_joining && leaveYearOf(String(emp.date_of_joining), startMonth) > year;
  }

  /** The year's own credit for one type: the up-front grant, or the monthly accruals falling due so far. */
  private async credit(q: Queryable, employeeId: string, emp: any, t: any, year: number, s: any, now: Date) {
    if (t.accrual === 'upfront') {
      const has = await q.query(
        `select 1 from leave_ledger where employee_id = $1 and leave_type_id = $2 and year = $3 and entry_type = 'opening'`,
        [employeeId, t.id, year]);
      if (has.rowCount) return;
      const days = prorateUpfront(t.annual_entitlement, emp.date_of_joining, year, s.leave_year_start_month);
      await q.query(
        `insert into leave_ledger (employee_id, leave_type_id, year, entry_type, days, note) values ($1,$2,$3,'opening',$4,$5)`,
        [employeeId, t.id, year, days, `Annual entitlement ${year}`]);
      return;
    }
    const currentMonth = todayIst(now).slice(0, 7);
    const joinMonth: string | null = emp.date_of_joining ? String(emp.date_of_joining).slice(0, 7) : null;
    for (const [i, month] of leaveMonths(year, s.leave_year_start_month).entries()) {
      if (month > currentMonth) break;
      if (joinMonth && month < joinMonth) continue;
      const has = await q.query(
        `select 1 from leave_ledger where employee_id = $1 and leave_type_id = $2 and year = $3 and entry_type = 'accrual' and note = $4`,
        [employeeId, t.id, year, month]);
      if (has.rowCount) continue;
      await q.query(
        `insert into leave_ledger (employee_id, leave_type_id, year, entry_type, days, note) values ($1,$2,$3,'accrual',$4,$5)`,
        [employeeId, t.id, year, monthlyAccrual(t.annual_entitlement, i + 1), month]);
    }
  }

  /**
   * At the start of a leave year: carry over up to the type's cap, and lapse the rest of last year's
   * balance. If the ledger already has entries for last year, its own credits are completed first, so
   * a missed accrual run cannot cause too little to be carried. Nothing is invented for years the
   * ledger has no record of (for example, before the system went live).
   */
  private async carryForward(q: Queryable, employeeId: string, emp: any, type: any, year: number, s: any, now: Date) {
    const done = await q.query(
      `select 1 from leave_ledger where employee_id = $1 and leave_type_id = $2 and year = $3 and entry_type = 'carry_forward'`,
      [employeeId, type.id, year]);
    if (done.rowCount) return;

    // Always lock the earlier year after the later one, so two requests can never wait on each other.
    await this.lockYear(q, employeeId, year - 1);
    const has = await q.query(
      `select 1 from leave_ledger where employee_id = $1 and leave_type_id = $2 and year = $3 limit 1`, [employeeId, type.id, year - 1]);
    if (!has.rowCount) return;
    if (!this.joinedAfter(emp, year - 1, s.leave_year_start_month)) await this.credit(q, employeeId, emp, type, year - 1, s, now);

    const prior = (await q.query(
      `select coalesce(sum(days), 0) as bal from leave_ledger where employee_id = $1 and leave_type_id = $2 and year = $3`,
      [employeeId, type.id, year - 1])).rows[0];
    const carry = Math.min(Math.max(prior.bal, 0), type.carry_forward_max);
    const lapse = Math.round((prior.bal - carry) * 100) / 100;
    if (lapse > 0) {
      await q.query(
        `insert into leave_ledger (employee_id, leave_type_id, year, entry_type, days, note) values ($1,$2,$3,'lapse',$4,$5)`,
        [employeeId, type.id, year - 1, -lapse, 'Lapsed at year end']);
    }
    await q.query(
      `insert into leave_ledger (employee_id, leave_type_id, year, entry_type, days, note) values ($1,$2,$3,'carry_forward',$4,$5)`,
      [employeeId, type.id, year, carry, `Carried forward from ${year - 1}`]);
  }

  async currentYear(): Promise<number> {
    const s = await this.settings.get();
    return leaveYearOf(todayIst(), s.leave_year_start_month);
  }

  async balances(employeeId: string, year?: number) {
    const y = year ?? (await this.currentYear());
    return this.db.tx(async (q) => {
      await this.ensureEntitlements(q, employeeId, y);
      return this.computeBalances(q, employeeId, y);
    });
  }

  private async computeBalances(q: Queryable, employeeId: string, year: number) {
    const s = await this.settings.get();
    const [start, end] = leaveYearBounds(year, s.leave_year_start_month);
    const emp = (await q.query('select employment_type from employees where id = $1', [employeeId])).rows[0];
    const types = (await q.query(
      `select * from leave_types where active and applicable_employment_types @> array[$1]::text[] order by sort_order, name`,
      [emp.employment_type])).rows;
    const ledger = (await q.query(
      `select leave_type_id, entry_type, sum(days) as days from leave_ledger where employee_id = $1 and year = $2 group by 1, 2`,
      [employeeId, year])).rows;
    const pending = (await q.query(
      `select leave_type_id, sum(days) as days from leave_requests
        where employee_id = $1 and status = 'pending' and from_date between $2 and $3 group by 1`,
      [employeeId, start, end])).rows;

    return types.map((t) => {
      const mine = ledger.filter((l) => l.leave_type_id === t.id);
      const balance = round2(mine.reduce((n, l) => n + l.days, 0));
      const used = round2(-mine.filter((l) => l.entry_type === 'debit' || l.entry_type === 'reversal').reduce((n, l) => n + l.days, 0));
      const held = round2(pending.find((p) => p.leave_type_id === t.id)?.days ?? 0);
      return {
        leaveTypeId: t.id as string, code: t.code as string, name: t.name as string, paid: t.paid as boolean,
        allowHalfDay: t.allow_half_day as boolean, unlimited: !t.paid,
        entitlement: round2(mine.filter((l) => ['opening', 'accrual', 'carry_forward'].includes(l.entry_type)).reduce((n, l) => n + l.days, 0)),
        used, pending: held, balance, available: round2(balance - held), year,
      };
    });
  }

  /** Someone else's balances: only if the viewer may see that employee's record. */
  async balancesForViewer(viewer: AuthUser, employeeId: string, year?: number) {
    await this.employees.getForViewer(viewer, employeeId);
    return this.balances(employeeId, year);
  }

  async adjust(actor: AuthUser, input: { employeeId: string; leaveTypeId: string; year: number; days: number; note: string }) {
    const type = await this.db.one('select id, code from leave_types where id = $1', [input.leaveTypeId]);
    if (!type) throw notFound('LEAVE_TYPE_NOT_FOUND', 'Leave type not found');
    await this.employees.getProfile(input.employeeId);
    return this.db.tx(async (q) => {
      await this.ensureEntitlements(q, input.employeeId, input.year);
      await q.query(
        `insert into leave_ledger (employee_id, leave_type_id, year, entry_type, days, ref_type, note, created_by)
         values ($1,$2,$3,'adjustment',$4,'manual',$5,$6)`,
        [input.employeeId, input.leaveTypeId, input.year, input.days, input.note, actor.id]);
      await this.audit.record({ actorId: actor.id, action: 'leave.adjust', entityType: 'employee', entityId: input.employeeId,
        after: { leaveType: type.code, year: input.year, days: input.days, note: input.note } }, q);
      return (await this.computeBalances(q, input.employeeId, input.year)).find((b) => b.leaveTypeId === input.leaveTypeId);
    });
  }

  /** Scheduled monthly (and safe to run any time): brings every active employee's ledger up to date. */
  async runAccrual(now: Date = new Date()): Promise<{ employees: number }> {
    const s = await this.settings.get();
    const year = leaveYearOf(todayIst(now), s.leave_year_start_month);
    const people = await this.db.rows(`select id from employees where status = 'active'`);
    for (const p of people) await this.db.tx((q) => this.ensureEntitlements(q, p.id, year, now));
    return { employees: people.length };
  }

  // ------------------------------------------------------------------ apply

  async apply(user: AuthUser, input: ApplyLeaveInput) {
    const s = await this.settings.get();
    const today = todayIst();

    const emp = await this.db.one('select employment_type from employees where id = $1', [user.id]);
    const type = await this.db.one(
      `select * from leave_types where id = $1 and active and applicable_employment_types @> array[$2]::text[]`,
      [input.leaveTypeId, emp!.employment_type]);
    if (!type) throw badRequest('LEAVE_TYPE_INVALID', 'That leave type is not available to you');

    if (input.toDate < input.fromDate) throw badRequest('BAD_DATES', 'The end date is before the start date');
    if (input.dayPart !== 'full') {
      if (!type.allow_half_day) throw badRequest('HALF_DAY_NOT_ALLOWED', `${type.name} cannot be taken as a half day`);
      if (input.fromDate !== input.toDate) throw badRequest('HALF_DAY_RANGE', 'A half day applies to a single date');
    }
    if (input.fromDate < addDays(today, -s.leave_backdate_days)) {
      throw badRequest('TOO_OLD', `Leave can be applied up to ${s.leave_backdate_days} days after the fact. Please contact HR`);
    }
    const year = leaveYearOf(input.fromDate, s.leave_year_start_month);
    if (leaveYearOf(input.toDate, s.leave_year_start_month) !== year) {
      throw badRequest('SPANS_LEAVE_YEARS', 'Please apply separately for each leave year');
    }
    if (year > leaveYearOf(today, s.leave_year_start_month) + 1) throw badRequest('TOO_FAR_AHEAD', 'That date is too far ahead');

    const holidayRows = await this.db.rows(
      `select holiday_date::text as d from holidays where holiday_date between $1 and $2 and not optional`, [input.fromDate, input.toDate]);
    const { days } = countLeaveDays({
      from: input.fromDate, to: input.toDate, dayPart: input.dayPart,
      holidays: new Set(holidayRows.map((h) => h.d)), weeklyOffDays: s.weekly_off_days,
    });
    if (days === 0) throw badRequest('NO_WORKING_DAYS', 'Those dates are all holidays or weekly offs, so no leave is needed');

    const id = await this.db.tx(async (q) => {
      await q.query('select pg_advisory_xact_lock(hashtext($1))', [`leave-apply:${user.id}`]);

      const clash = (await q.query(
        `select from_date, to_date, day_part from leave_requests
          where employee_id = $1 and status in ('pending','approved') and from_date <= $3 and to_date >= $2`,
        [user.id, input.fromDate, input.toDate])).rows;
      if (clash.some((c) => overlaps(c, input))) {
        throw conflict('OVERLAP', 'You already have leave applied on some of these dates');
      }
      const od = await q.query(
        `select 1 from od_requests where employee_id = $1 and kind = 'od' and status in ('pending','approved')
            and from_date <= $3 and to_date >= $2 limit 1`, [user.id, input.fromDate, input.toDate]);
      if (od.rowCount) throw conflict('OD_CONFLICT', 'You have an on-duty request on some of these dates');

      if (type.paid) {
        await this.ensureEntitlements(q, user.id, year);
        const bal = (await this.computeBalances(q, user.id, year)).find((b) => b.leaveTypeId === type.id);
        if (!bal || bal.available < days) {
          throw conflict('INSUFFICIENT_BALANCE',
            `Not enough ${type.name}: ${days} day(s) requested, ${bal?.available ?? 0} available`,
            { requested: days, available: bal?.available ?? 0 });
        }
      }

      const req = (await q.query(
        `insert into leave_requests (employee_id, leave_type_id, from_date, to_date, day_part, days, reason)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [user.id, type.id, input.fromDate, input.toDate, input.dayPart, days, input.reason])).rows[0];

      const summary = `${type.name}: ${prettyDate(input.fromDate)}${input.toDate !== input.fromDate ? ` to ${prettyDate(input.toDate)}` : ''}` +
        ` (${days} day${days === 1 ? '' : 's'}${input.dayPart !== 'full' ? `, ${input.dayPart === 'first_half' ? 'first' : 'second'} half` : ''}) — ${user.fullName}`;
      const approvalId = await this.approvals.submit(q, { type: 'leave', refId: req.id, requesterId: user.id, summary, size: days });
      await q.query('update leave_requests set approval_request_id = $2 where id = $1', [req.id, approvalId]);
      await this.audit.record({ actorId: user.id, action: 'leave.apply', entityType: 'leave_request', entityId: req.id,
        after: { ...input, days } }, q);
      return req.id as string;
    });
    return this.getOne(id);
  }

  // ----------------------------------------------------------------- cancel

  async cancel(user: AuthUser, id: string) {
    await this.db.tx(async (q) => {
      // Lock the approval first, then the leave row — the same order a decision takes — so a cancel
      // racing an approval waits its turn instead of deadlocking.
      const pre = (await q.query('select approval_request_id from leave_requests where id = $1', [id])).rows[0];
      if (!pre) throw notFound('LEAVE_NOT_FOUND', 'Leave request not found');
      if (pre.approval_request_id) await q.query('select 1 from approval_requests where id = $1 for update', [pre.approval_request_id]);
      const row = (await q.query('select * from leave_requests where id = $1 for update', [id])).rows[0];
      const isHr = hasRole(user, 'hr_admin');
      if (row.employee_id !== user.id && !isHr) throw forbidden('FORBIDDEN', 'You can only cancel your own leave');

      if (row.status === 'pending') {
        await this.approvals.cancelPending(q, row.approval_request_id, user.id);
      } else if (row.status === 'approved') {
        if (!isHr && row.from_date <= todayIst()) {
          throw conflict('ALREADY_STARTED', 'Leave that has already started can only be cancelled by HR');
        }
        // Give back whatever this request still has debited (net of any earlier reversal).
        const entries = (await q.query(
          `select leave_type_id, year, entry_type, days from leave_ledger
            where ref_type = 'leave_request' and ref_id = $1 and entry_type in ('debit','reversal')`, [id])).rows;
        const net = round2(entries.reduce((n, e) => n + e.days, 0));
        const debit = entries.find((e) => e.entry_type === 'debit');
        if (net < 0 && debit) {
          await q.query(
            `insert into leave_ledger (employee_id, leave_type_id, year, entry_type, days, ref_type, ref_id, note, created_by)
             values ($1,$2,$3,'reversal',$4,'leave_request',$5,'Leave cancelled',$6)`,
            [row.employee_id, debit.leave_type_id, debit.year, -net, id, user.id]);
        }
        await this.approvals.cancelApproved(q, row.approval_request_id, user.id);
        await this.recalc.run(q, row.employee_id, row.from_date, row.to_date);
      } else {
        throw conflict('NOT_CANCELLABLE', `This request is already ${row.status}`);
      }
      await q.query(`update leave_requests set status = 'cancelled', updated_at = now() where id = $1`, [id]);
      await this.audit.record({ actorId: user.id, action: 'leave.cancel', entityType: 'leave_request', entityId: id, before: { status: row.status } }, q);
    });
    return this.getOne(id);
  }

  // -------------------------------------------------------- approval hooks

  private async onApproved(q: Queryable, req: ApprovalRequestRow) {
    const row = (await q.query(
      `select lr.*, lt.paid from leave_requests lr join leave_types lt on lt.id = lr.leave_type_id where lr.id = $1 for update`,
      [req.refId])).rows[0];
    const s = await this.settings.get();
    await q.query(`update leave_requests set status = 'approved', updated_at = now() where id = $1`, [row.id]);
    if (row.paid) {
      await q.query(
        `insert into leave_ledger (employee_id, leave_type_id, year, entry_type, days, ref_type, ref_id, note)
         values ($1,$2,$3,'debit',$4,'leave_request',$5,$6)`,
        [row.employee_id, row.leave_type_id, leaveYearOf(row.from_date, s.leave_year_start_month), -row.days, row.id,
         `${prettyDate(row.from_date)}${row.to_date !== row.from_date ? ` to ${prettyDate(row.to_date)}` : ''}`]);
    }
    await this.recalc.run(q, row.employee_id, row.from_date, row.to_date);
  }

  private async onRejected(q: Queryable, req: ApprovalRequestRow) {
    await q.query(`update leave_requests set status = 'rejected', updated_at = now() where id = $1`, [req.refId]);
  }

  // ------------------------------------------------------------------ reads

  async getOne(id: string) {
    const row = await this.db.one(`${REQUEST_SQL} where lr.id = $1`, [id]);
    if (!row) throw notFound('LEAVE_NOT_FOUND', 'Leave request not found');
    return (await this.withApproval([row]))[0];
  }

  async getForViewer(viewer: AuthUser, id: string) {
    const view = await this.getOne(id);
    if (view.employeeId !== viewer.id && !hasRole(viewer, 'hr_admin')) {
      const scope = await this.employees.teamScope(viewer);
      if (!scope?.includes(view.employeeId)) throw forbidden('FORBIDDEN', 'You do not have access to this leave request');
    }
    return view;
  }

  async mine(user: AuthUser, year?: number) {
    const s = await this.settings.get();
    const [start, end] = leaveYearBounds(year ?? (await this.currentYear()), s.leave_year_start_month);
    const rows = await this.db.rows(
      `${REQUEST_SQL} where lr.employee_id = $1 and lr.from_date between $2 and $3 order by lr.from_date desc`, [user.id, start, end]);
    return this.withApproval(rows);
  }

  /** Leave requests from the people this person manages (everyone, for HR). */
  async team(user: AuthUser, filter: { status?: string; from?: string; to?: string }) {
    const scope = await this.employees.teamScope(user);
    if (scope && !scope.length) return [];
    const rows = await this.db.rows(
      `${REQUEST_SQL}
        where ($1::uuid[] is null or lr.employee_id = any($1))
          and ($2::text is null or lr.status = $2)
          and ($3::date is null or lr.to_date >= $3) and ($4::date is null or lr.from_date <= $4)
        order by lr.from_date desc limit 300`,
      [scope, filter.status ?? null, filter.from ?? null, filter.to ?? null]);
    return this.withApproval(rows);
  }

  /** Who is off when: your own leave plus your team's. */
  async calendar(user: AuthUser, from: string, to: string) {
    const scope = await this.employees.teamScope(user);
    const ids = scope === null ? null : [user.id, ...scope];
    const rows = await this.db.rows(
      `select lr.id, lr.employee_id, e.full_name, lt.code, lr.from_date, lr.to_date, lr.day_part, lr.status
         from leave_requests lr join employees e on e.id = lr.employee_id join leave_types lt on lt.id = lr.leave_type_id
        where lr.status in ('approved','pending') and lr.from_date <= $2 and lr.to_date >= $1
          and ($3::uuid[] is null or lr.employee_id = any($3))
        order by lr.from_date`, [from, to, ids]);
    return rows.map((r) => ({
      id: r.id, employeeId: r.employee_id, employeeName: r.full_name, leaveTypeCode: r.code,
      fromDate: r.from_date, toDate: r.to_date, dayPart: r.day_part, status: r.status,
    }));
  }

  private async withApproval(rows: any[]) {
    const summaries = await this.approvals.summaries(rows.map((r) => r.approval_request_id).filter(Boolean));
    return rows.map((r) => {
      const a = summaries.get(r.approval_request_id);
      return {
        id: r.id as string, employeeId: r.employee_id as string, employeeName: r.employee_name as string, empCode: r.emp_code as string,
        leaveTypeId: r.leave_type_id as string, leaveTypeCode: r.leave_type_code as string, leaveTypeName: r.leave_type_name as string,
        fromDate: r.from_date as string, toDate: r.to_date as string, dayPart: r.day_part as DayPart, days: r.days as number,
        reason: r.reason as string, status: r.status as string, approvalRequestId: r.approval_request_id as string | null,
        currentApprover: a?.currentApprover ?? null, lastComment: a?.lastComment ?? null, createdAt: r.created_at as Date,
      };
    });
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function typeView(t: any) {
  return {
    id: t.id as string, code: t.code as string, name: t.name as string, annualEntitlement: t.annual_entitlement as number,
    accrual: t.accrual as string, carryForwardMax: t.carry_forward_max as number, allowHalfDay: t.allow_half_day as boolean,
    paid: t.paid as boolean, applicableEmploymentTypes: t.applicable_employment_types as string[],
    requiresDocumentAfterDays: t.requires_document_after_days as number | null, active: t.active as boolean, sortOrder: t.sort_order as number,
  };
}

/** Two requests clash if their dates overlap — except two different half days on the same single date. */
function overlaps(existing: { from_date: string; to_date: string; day_part: string }, req: { fromDate: string; toDate: string; dayPart: string }) {
  const sameSingleDay = existing.from_date === existing.to_date && req.fromDate === req.toDate && existing.from_date === req.fromDate;
  if (sameSingleDay && existing.day_part !== 'full' && req.dayPart !== 'full' && existing.day_part !== req.dayPart) return false;
  return true;
}
