import { AuthUser } from '../src/common/auth.types';
import { addDays, todayIst } from '../src/common/dates';
import { DayRecalc } from '../src/common/day-recalc.service';
import { LeaveService } from '../src/leave/leave.service';
import { futureMonday, recentWeekday, yearOf } from './dates';
import { TestEnv, createTestEnv } from './helpers';
import { applyLeave, balanceOf, decide, inboxIds, typeId } from './leave-helpers';

describe('leave management', () => {
  let env: TestEnv;
  const monday = futureMonday();
  const year = yearOf(monday);
  const thisYear = Number(todayIst().slice(0, 4));
  const thisMonth = Number(todayIst().slice(5, 7));

  const ledger = (employeeId: string, code: string) =>
    env.db.rows(
      `select l.entry_type, l.days, l.year, l.note from leave_ledger l join leave_types t on t.id = l.leave_type_id
        where l.employee_id = $1 and t.code = $2 order by l.id`, [employeeId, code]);
  const typeIdSql = async (code: string) => (await env.db.one('select id from leave_types where code = $1', [code]))!.id as string;

  beforeAll(async () => {
    env = await createTestEnv();
  });
  beforeEach(async () => {
    await env.reset();
    await env.db.query('delete from holidays');
    env.app.get(DayRecalc).register(async () => undefined);
  });
  afterAll(() => env.close());

  describe('entitlements and balances', () => {
    it('offers each person the leave types for their employment type', async () => {
      const priya = await env.as('priya');
      expect((await priya.get('/api/leave/types')).body.map((t: any) => t.code)).toEqual(['CL', 'EL', 'SL', 'LOP']);

      await env.db.query(`update employees set employment_type = 'consultant' where id = $1`, [env.ids.ravi]);
      const ravi = await env.as('ravi');
      expect((await ravi.get('/api/leave/types')).body.map((t: any) => t.code)).toEqual(['LOP']);
    });

    it('credits up-front types in full and accrues monthly types month by month', async () => {
      const priya = await env.as('priya');
      const res = await priya.get('/api/leave/balances');
      const by = Object.fromEntries(res.body.map((b: any) => [b.code, b]));
      expect(by.CL).toMatchObject({ entitlement: 12, balance: 12, available: 12, used: 0, pending: 0, unlimited: false, year: thisYear });
      expect(by.SL).toMatchObject({ entitlement: 12, balance: 12 });
      expect(by.EL.balance).toBeCloseTo((15 * thisMonth) / 12, 2);
      expect(by.LOP).toMatchObject({ unlimited: true, balance: 0 });
    });

    it('is idempotent, even when many requests arrive at once', async () => {
      const leave = env.app.get(LeaveService);
      await Promise.all([1, 2, 3, 4].map(() => leave.balances(env.ids.priya)));
      await leave.balances(env.ids.priya);
      expect((await ledger(env.ids.priya, 'CL')).filter((l) => l.entry_type === 'opening')).toHaveLength(1);
      expect((await ledger(env.ids.priya, 'EL')).filter((l) => l.entry_type === 'accrual')).toHaveLength(thisMonth);
    });

    it('prorates a mid-year joiner, and gives nothing for years before they joined', async () => {
      await env.db.query(`update employees set date_of_joining = $2 where id = $1`, [env.ids.priya, `${thisYear}-07-15`]);
      const priya = await env.as('priya');
      expect((await balanceOf(priya, 'CL')).entitlement).toBe(6);
      expect((await balanceOf(priya, 'CL', thisYear - 1))).toMatchObject({ entitlement: 0, balance: 0 });
    });

    it('carries forward up to the cap and lapses the rest, once', async () => {
      const leave = env.app.get(LeaveService);
      const el = await typeIdSql('EL');
      // Last year as the system would have credited it, plus 5 extra earned days from HR: 20 left over, cap is 15.
      await leave.balances(env.ids.priya, thisYear - 1);
      await env.db.query(
        `insert into leave_ledger (employee_id, leave_type_id, year, entry_type, days, note) values ($1,$2,$3,'adjustment',5,'HR credit')`,
        [env.ids.priya, el, thisYear - 1]);

      const priya = await env.as('priya');
      await priya.get('/api/leave/balances');
      await priya.get('/api/leave/balances');

      expect(await ledger(env.ids.priya, 'CL')).toEqual([
        expect.objectContaining({ entry_type: 'opening', year: thisYear - 1, days: 12 }),
        expect.objectContaining({ entry_type: 'lapse', year: thisYear - 1, days: -12 }),
        expect.objectContaining({ entry_type: 'carry_forward', year: thisYear, days: 0 }),
        expect.objectContaining({ entry_type: 'opening', year: thisYear, days: 12 }),
      ]);
      const elRows = await ledger(env.ids.priya, 'EL');
      expect(elRows.filter((l) => l.entry_type === 'carry_forward')).toEqual([expect.objectContaining({ year: thisYear, days: 15 })]);
      expect(elRows.filter((l) => l.entry_type === 'lapse')).toEqual([expect.objectContaining({ year: thisYear - 1, days: -5 })]);
      expect((await balanceOf(priya, 'EL')).balance).toBeCloseTo(15 + (15 * thisMonth) / 12, 2);
      expect((await balanceOf(priya, 'EL', thisYear - 1)).balance).toBe(15); // 20 less the 5 that lapsed
    });

    it('completes last year\'s missed accruals before carrying forward', async () => {
      // The accrual job ran once last January and then stopped; the year-end view must not under-carry.
      await env.db.query(
        `insert into leave_ledger (employee_id, leave_type_id, year, entry_type, days, note) values ($1,$2,$3,'accrual',1.25,$4)`,
        [env.ids.priya, await typeIdSql('EL'), thisYear - 1, `${thisYear - 1}-01`]);
      const priya = await env.as('priya');
      await priya.get('/api/leave/balances');

      const rows = await ledger(env.ids.priya, 'EL');
      const lastYear = rows.filter((l) => l.year === thisYear - 1);
      expect(lastYear.filter((l) => l.entry_type === 'accrual')).toHaveLength(12);
      expect(lastYear.some((l) => l.entry_type === 'lapse')).toBe(false);
      expect(rows.find((l) => l.entry_type === 'carry_forward')).toMatchObject({ year: thisYear, days: 15 });
    });

    it('invents no history: with nothing recorded for last year, nothing is carried', async () => {
      await (await env.as('priya')).get('/api/leave/balances');
      const el = await ledger(env.ids.priya, 'EL');
      expect(el.filter((l) => l.entry_type === 'carry_forward' || l.year !== thisYear)).toEqual([]);
    });

    it('the database itself refuses a second yearly credit', async () => {
      await (await env.as('priya')).get('/api/leave/balances');
      const dup = (type: string, entry: string, note: string | null) => env.db.query(
        `insert into leave_ledger (employee_id, leave_type_id, year, entry_type, days, note) values ($1,$2,$3,$4,1,$5)`,
        [env.ids.priya, type, thisYear, entry, note]);
      await expect(dup(await typeIdSql('CL'), 'opening', 'again')).rejects.toMatchObject({ code: '23505' });
      await expect(dup(await typeIdSql('EL'), 'accrual', `${thisYear}-01`)).rejects.toMatchObject({ code: '23505' });
      await dup(await typeIdSql('CL'), 'adjustment', 'manual adjustments can repeat'); // not restricted
    });

    it('the accrual job brings every active employee up to date, and can be re-run', async () => {
      const leave = env.app.get(LeaveService);
      const june2030 = new Date('2030-06-15T06:00:00Z');
      expect(await leave.runAccrual(june2030)).toEqual({ employees: 9 });
      const before = (await env.db.one('select count(*)::int as n from leave_ledger'))!.n;
      await leave.runAccrual(june2030);
      expect((await env.db.one('select count(*)::int as n from leave_ledger'))!.n).toBe(before);

      const el = await env.db.one(
        `select sum(days) as d from leave_ledger l join leave_types t on t.id = l.leave_type_id where l.employee_id = $1 and t.code = 'EL' and l.year = 2030`, [env.ids.priya]);
      expect(el!.d).toBeCloseTo(7.5, 2); // January to June
    });

    it('shows someone else\'s balances only to those who may see their record', async () => {
      const url = `/api/employees/${env.ids.priya}/leave-balances`;
      for (const who of ['priya', 'mani', 'hari', 'hema']) expect((await (await env.as(who)).get(url)).status).toBe(200);
      for (const who of ['ravi', 'arun']) expect((await (await env.as(who)).get(url)).status).toBe(403);
    });
  });

  describe('applying', () => {
    it('creates a pending request that holds the days without spending them', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, addDays(monday, 1), { reason: 'Cousin\'s wedding' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'pending', days: 2, dayPart: 'full', leaveTypeCode: 'CL', employeeName: 'Priya Raman', reason: 'Cousin\'s wedding',
        currentApprover: 'Mani Kandan',
      });
      expect(await balanceOf(priya, 'CL', year)).toMatchObject({ balance: 12, pending: 2, available: 10, used: 0 });
    });

    it('counts only working days: weekends and fixed holidays are free, optional holidays are not', async () => {
      const priya = await env.as('priya');
      const fri2mon = await applyLeave(priya, 'CL', addDays(monday, 4), addDays(monday, 7));
      expect(fri2mon.body.days).toBe(2);

      await env.db.query(`insert into holidays (holiday_date, name) values ($1, 'Test holiday')`, [addDays(monday, 15)]);
      await env.db.query(`insert into holidays (holiday_date, name, optional) values ($1, 'Optional day', true)`, [addDays(monday, 16)]);
      const withHoliday = await applyLeave(priya, 'CL', addDays(monday, 14), addDays(monday, 16));
      expect(withHoliday.body.days).toBe(2); // Mon, Wed — Tuesday is a holiday; Wednesday's optional holiday still counts
    });

    it('refuses leave that falls entirely on days off', async () => {
      const res = await applyLeave(await env.as('priya'), 'CL', addDays(monday, 5), addDays(monday, 6));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NO_WORKING_DAYS');
    });

    it('supports a half day on a single date only, and only for types that allow it', async () => {
      const priya = await env.as('priya');
      const half = await applyLeave(priya, 'CL', monday, monday, { dayPart: 'first_half' });
      expect(half.status).toBe(201);
      expect(half.body).toMatchObject({ days: 0.5, dayPart: 'first_half' });
      expect((await balanceOf(priya, 'CL', year)).available).toBe(11.5);

      const range = await applyLeave(priya, 'CL', addDays(monday, 1), addDays(monday, 2), { dayPart: 'second_half' });
      expect(range.body.code).toBe('HALF_DAY_RANGE');

      const hr = await env.as('hema');
      await hr.patch(`/api/admin/leave-types/${await typeIdSql('SL')}`).send({ allowHalfDay: false });
      const sl = await applyLeave(priya, 'SL', addDays(monday, 1), addDays(monday, 1), { dayPart: 'first_half' });
      expect(sl.body.code).toBe('HALF_DAY_NOT_ALLOWED');
    });

    it('lets the two halves of one day be taken separately, but not the same half twice', async () => {
      const priya = await env.as('priya');
      expect((await applyLeave(priya, 'CL', monday, monday, { dayPart: 'first_half' })).status).toBe(201);
      expect((await applyLeave(priya, 'SL', monday, monday, { dayPart: 'second_half' })).status).toBe(201);
      const again = await applyLeave(priya, 'CL', monday, monday, { dayPart: 'first_half' });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('OVERLAP');
    });

    it('rejects overlapping leave, but a rejected or cancelled request frees the dates', async () => {
      const priya = await env.as('priya');
      const first = await applyLeave(priya, 'CL', monday, addDays(monday, 2));
      const clash = await applyLeave(priya, 'SL', addDays(monday, 2), addDays(monday, 3));
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('OVERLAP');

      await decide(await env.as('mani'), first.body.approvalRequestId, 'reject', 'Team is short that week');
      expect((await applyLeave(priya, 'SL', addDays(monday, 2), addDays(monday, 3))).status).toBe(201);
    });

    it('refuses leave on days with an on-duty request', async () => {
      await env.db.query(
        `insert into od_requests (employee_id, kind, from_date, to_date, purpose) values ($1, 'od', $2, $2, 'Investor meet')`,
        [env.ids.priya, monday]);
      const res = await applyLeave(await env.as('priya'), 'CL', monday, addDays(monday, 1));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('OD_CONFLICT');
    });

    it('checks the balance against what is already pending, so two requests cannot overspend', async () => {
      const priya = await env.as('priya');
      expect((await applyLeave(priya, 'CL', monday, addDays(monday, 11))).body.days).toBe(10);
      const over = await applyLeave(priya, 'CL', addDays(monday, 14), addDays(monday, 16));
      expect(over.status).toBe(409);
      expect(over.body).toMatchObject({ code: 'INSUFFICIENT_BALANCE', requested: 3, available: 2 });
      expect((await applyLeave(priya, 'CL', addDays(monday, 14), addDays(monday, 15))).status).toBe(201);
    });

    it('serialises simultaneous requests from the same person', async () => {
      const leave = env.app.get(LeaveService);
      const priya: AuthUser = {
        id: env.ids.priya, empCode: 'E004', fullName: 'Priya Raman', email: 'priya@startuptn.in', roles: [],
        departmentId: env.ids.deptOps, reportingManagerId: env.ids.manager,
      };
      const clId = await typeIdSql('CL');
      const body = (fromDate: string, toDate: string) => ({ leaveTypeId: clId, fromDate, toDate, dayPart: 'full' as const, reason: 'Trip' });
      // 7 + 6 working days against a balance of 12: one must fail.
      const results = await Promise.allSettled([
        leave.apply(priya, body(monday, addDays(monday, 8))),
        leave.apply(priya, body(addDays(monday, 14), addDays(monday, 21))),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect((failed.reason.getResponse() as any).code).toBe('INSUFFICIENT_BALANCE');
    });

    it('has no balance limit for loss-of-pay and never debits it', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'LOP', monday, addDays(monday, 16));
      expect(res.status).toBe(201);
      expect(res.body.days).toBe(13);
      await decide(await env.as('mani'), res.body.approvalRequestId, 'approve');
      await decide(await env.as('hari'), res.body.approvalRequestId, 'approve');
      expect((await priya.get(`/api/leave/requests/${res.body.id}`)).body.status).toBe('approved');
      expect(await ledger(env.ids.priya, 'LOP')).toEqual([]);
    });

    it('enforces the date rules', async () => {
      const priya = await env.as('priya');
      const code = async (from: string, to: string) => (await applyLeave(priya, 'CL', from, to)).body.code;
      expect(await code(addDays(monday, 3), monday)).toBe('BAD_DATES');
      expect(await code(addDays(todayIst(), -30), addDays(todayIst(), -30))).toBe('TOO_OLD');
      expect(await code('2030-12-30', '2031-01-02')).toBe('SPANS_LEAVE_YEARS');
      expect(await code('2040-03-04', '2040-03-04')).toBe('TOO_FAR_AHEAD');
      expect(await code('2026-13-45', '2026-13-46')).toBe('VALIDATION');
      // The recent past is fine, within the backdating window.
      expect((await applyLeave(priya, 'CL', recentWeekday(), recentWeekday())).status).toBe(201);
    });

    it('validates the request body and the type', async () => {
      const priya = await env.as('priya');
      const clId = await typeId(priya, 'CL');
      expect((await priya.post('/api/leave/requests').send({ leaveTypeId: clId, fromDate: monday, toDate: monday, reason: 'x' })).body.code).toBe('VALIDATION');
      expect((await priya.post('/api/leave/requests').send({ leaveTypeId: 'nope', fromDate: monday, toDate: monday, reason: 'Trip' })).body.code).toBe('VALIDATION');
      expect((await priya.post('/api/leave/requests').send({ leaveTypeId: '11111111-1111-4111-8111-111111111111', fromDate: monday, toDate: monday, reason: 'Trip' })).body.code).toBe('LEAVE_TYPE_INVALID');

      // A consultant cannot take Casual Leave even by guessing its id.
      await env.db.query(`update employees set employment_type = 'consultant' where id = $1`, [env.ids.ravi]);
      const ravi = await env.as('ravi');
      expect((await ravi.post('/api/leave/requests').send({ leaveTypeId: clId, fromDate: monday, toDate: monday, reason: 'Trip' })).body.code).toBe('LEAVE_TYPE_INVALID');
    });

    it('needs a signed-in user', async () => {
      expect((await env.anon().get('/api/leave/balances')).status).toBe(401);
      expect((await env.anon().post('/api/leave/requests').send({})).status).toBe(401);
    });
  });

  describe('cancelling', () => {
    it('withdraws a pending request: approval closed, days released', async () => {
      const priya = await env.as('priya');
      const mani = await env.as('mani');
      const res = await applyLeave(priya, 'CL', monday, addDays(monday, 1));
      const cancel = await priya.post(`/api/leave/requests/${res.body.id}/cancel`);
      expect(cancel.status).toBe(200);
      expect(cancel.body.status).toBe('cancelled');
      expect(await inboxIds(mani)).toEqual([]);
      expect(await balanceOf(priya, 'CL', year)).toMatchObject({ pending: 0, available: 12 });
      expect((await decide(mani, res.body.approvalRequestId, 'approve')).body.code).toBe('ALREADY_DECIDED');
    });

    it('reverses approved leave that has not started, exactly once', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, addDays(monday, 1));
      await decide(await env.as('mani'), res.body.approvalRequestId, 'approve');
      expect(await balanceOf(priya, 'CL', year)).toMatchObject({ balance: 10, used: 2 });

      expect((await priya.post(`/api/leave/requests/${res.body.id}/cancel`)).body.status).toBe('cancelled');
      expect(await balanceOf(priya, 'CL', year)).toMatchObject({ balance: 12, used: 0, available: 12 });
      expect((await ledger(env.ids.priya, 'CL')).map((l) => l.entry_type)).toEqual(['opening', 'debit', 'reversal']);

      const again = await priya.post(`/api/leave/requests/${res.body.id}/cancel`);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('NOT_CANCELLABLE');
      expect((await balanceOf(priya, 'CL', year)).balance).toBe(12);
    });

    it('leave that has already started can be cancelled by HR, not by the employee', async () => {
      const day = recentWeekday();
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', day, day);
      expect(res.status).toBe(201);
      await decide(await env.as('mani'), res.body.approvalRequestId, 'approve');

      const mine = await priya.post(`/api/leave/requests/${res.body.id}/cancel`);
      expect(mine.status).toBe(409);
      expect(mine.body.code).toBe('ALREADY_STARTED');

      expect((await (await env.as('hema')).post(`/api/leave/requests/${res.body.id}/cancel`)).status).toBe(200);
      expect(await balanceOf(priya, 'CL', yearOf(day))).toMatchObject({ balance: 12, used: 0 });
    });

    it('cannot be done by a colleague, and not for a rejected request', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, monday);
      expect((await (await env.as('ravi')).post(`/api/leave/requests/${res.body.id}/cancel`)).status).toBe(403);
      expect((await (await env.as('mani')).post(`/api/leave/requests/${res.body.id}/cancel`)).status).toBe(403);

      await decide(await env.as('mani'), res.body.approvalRequestId, 'reject', 'Not this week');
      expect((await priya.post(`/api/leave/requests/${res.body.id}/cancel`)).body.code).toBe('NOT_CANCELLABLE');
      expect((await priya.post('/api/leave/requests/11111111-1111-4111-8111-111111111111/cancel')).status).toBe(404);
    });
  });

  describe('attendance and consistency hooks', () => {
    it('tells attendance to refresh the days when leave is approved or reversed', async () => {
      const calls: string[][] = [];
      env.app.get(DayRecalc).register(async (_q, employeeId, from, to) => { calls.push([employeeId, from, to]); });
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, addDays(monday, 1));
      expect(calls).toEqual([]);
      await decide(await env.as('mani'), res.body.approvalRequestId, 'approve');
      expect(calls).toEqual([[env.ids.priya, monday, addDays(monday, 1)]]);
      await priya.post(`/api/leave/requests/${res.body.id}/cancel`);
      expect(calls).toHaveLength(2);
    });

    it('approval is all-or-nothing: if updating attendance fails, nothing is half-done', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, monday);
      env.app.get(DayRecalc).register(async () => { throw new Error('boom'); });
      const failed = await decide(await env.as('mani'), res.body.approvalRequestId, 'approve');
      expect(failed.status).toBe(500);

      expect((await priya.get(`/api/leave/requests/${res.body.id}`)).body.status).toBe('pending');
      expect(await ledger(env.ids.priya, 'CL')).toEqual([expect.objectContaining({ entry_type: 'opening' })]);
      expect(await env.db.rows(`select 1 from email_outbox where subject like 'Approved:%'`)).toHaveLength(0);
      expect((await env.db.one('select status from approval_requests where id = $1', [res.body.approvalRequestId]))!.status).toBe('pending');

      env.app.get(DayRecalc).register(async () => undefined);
      expect((await decide(await env.as('mani'), res.body.approvalRequestId, 'approve')).body.status).toBe('approved');
    });

    it('records who did what in the audit trail', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, monday);
      await priya.post(`/api/leave/requests/${res.body.id}/cancel`);
      const rows = await env.db.rows(`select action, actor_id from audit_log where entity_id = $1 order by id`, [res.body.id]);
      expect(rows).toEqual([
        { action: 'leave.apply', actor_id: env.ids.priya },
        { action: 'leave.cancel', actor_id: env.ids.priya },
      ]);
    });
  });

  describe('viewing requests', () => {
    it('lists my requests, and my team\'s only to those who manage them', async () => {
      const priya = await env.as('priya');
      const ravi = await env.as('ravi');
      await applyLeave(priya, 'CL', monday, monday);
      await applyLeave(ravi, 'SL', addDays(monday, 1), addDays(monday, 1));

      expect((await priya.get('/api/leave/requests').query({ year })).body).toHaveLength(1);

      const names = async (who: string, q: object = {}) =>
        ((await (await env.as(who)).get('/api/leave/requests/team').query(q)).body as any[]).map((r) => r.employeeName).sort();
      expect(await names('mani')).toEqual(['Priya Raman', 'Ravi Kumar']);
      expect(await names('hari')).toEqual(['Priya Raman', 'Ravi Kumar']);
      expect(await names('hema')).toEqual(['Priya Raman', 'Ravi Kumar']);
      expect(await names('arun')).toEqual([]);
      expect(await names('ravi')).toEqual([]); // a peer sees nothing of Priya's
      expect(await names('mani', { status: 'approved' })).toEqual([]);
    });

    it('shows one request to its owner, their reporting line and HR only', async () => {
      const res = await applyLeave(await env.as('priya'), 'CL', monday, monday);
      for (const who of ['priya', 'mani', 'hari', 'hema']) expect((await (await env.as(who)).get(`/api/leave/requests/${res.body.id}`)).status).toBe(200);
      for (const who of ['ravi', 'arun']) expect((await (await env.as(who)).get(`/api/leave/requests/${res.body.id}`)).status).toBe(403);
      expect((await (await env.as('hema')).get('/api/leave/requests/11111111-1111-4111-8111-111111111111')).status).toBe(404);
    });

    it('shows a team calendar of who is away', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, addDays(monday, 1));
      await decide(await env.as('mani'), res.body.approvalRequestId, 'approve');
      const range = { from: monday, to: addDays(monday, 6) };

      const mani = await (await env.as('mani')).get('/api/leave/calendar').query(range);
      expect(mani.body).toEqual([expect.objectContaining({ employeeName: 'Priya Raman', leaveTypeCode: 'CL', status: 'approved', fromDate: monday })]);
      expect((await priya.get('/api/leave/calendar').query(range)).body).toHaveLength(1);
      expect((await (await env.as('ravi')).get('/api/leave/calendar').query(range)).body).toEqual([]);
      expect((await priya.get('/api/leave/calendar').query({ from: range.to, to: range.from })).status).toBe(400);
    });
  });

  describe('HR administration', () => {
    it('adjusts a balance with a mandatory note, and audits it', async () => {
      const hr = await env.as('hema');
      const clId = await typeIdSql('CL');
      const body = { employeeId: env.ids.priya, leaveTypeId: clId, year: thisYear, days: 2 };

      expect((await hr.post('/api/admin/leave-adjustments').send(body)).body.code).toBe('VALIDATION');
      const ok = await hr.post('/api/admin/leave-adjustments').send({ ...body, note: 'Comp-off for weekend event duty' });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ code: 'CL', balance: 14 });
      expect((await balanceOf(await env.as('priya'), 'CL')).balance).toBe(14);

      expect((await hr.post('/api/admin/leave-adjustments').send({ ...body, days: 0, note: 'nothing' })).status).toBe(400);
      expect((await (await env.as('mani')).post('/api/admin/leave-adjustments').send({ ...body, note: 'sneaky' })).status).toBe(403);
      const audit = await env.db.one(`select actor_id, after_data from audit_log where action = 'leave.adjust'`);
      expect(audit).toMatchObject({ actor_id: env.ids.hr, after_data: { leaveType: 'CL', days: 2 } });
    });

    it('creates and edits leave types; new ones reach employees straight away', async () => {
      const hr = await env.as('hema');
      const input = {
        code: 'comp', name: 'Compensatory Off', annualEntitlement: 2, accrual: 'upfront',
        applicableEmploymentTypes: ['permanent'], allowHalfDay: false,
      };
      const created = await hr.post('/api/admin/leave-types').send(input);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ code: 'COMP', paid: true, active: true, carryForwardMax: 0 });
      expect((await hr.post('/api/admin/leave-types').send(input)).body.code).toBe('LEAVE_TYPE_EXISTS');

      const priya = await env.as('priya');
      expect(await balanceOf(priya, 'COMP')).toMatchObject({ entitlement: 2, allowHalfDay: false });

      const patched = await hr.patch(`/api/admin/leave-types/${created.body.id}`).send({ active: false, name: 'Comp Off' });
      expect(patched.body).toMatchObject({ active: false, name: 'Comp Off' });
      expect(await balanceOf(priya, 'COMP')).toBeUndefined();
      expect((await hr.patch('/api/admin/leave-types/11111111-1111-4111-8111-111111111111').send({ active: false })).status).toBe(404);
    });

    it('is closed to everyone but HR', async () => {
      const priya = await env.as('priya');
      expect((await priya.get('/api/admin/leave-types')).status).toBe(403);
      expect((await priya.post('/api/admin/leave-types').send({})).status).toBe(403);
      expect((await (await env.as('hema')).get('/api/admin/leave-types')).body).toHaveLength(4);
    });
  });
});
