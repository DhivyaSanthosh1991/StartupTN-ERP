import { SettingsService } from '../src/common/settings.service';
import { applyLeavePolicy, ADMIN_TITLES } from '../src/db/leave-policy';
import { LeaveService } from '../src/leave/leave.service';
import { TestEnv, createTestEnv } from './helpers';
import { applyLeave, balanceOf, decide } from './leave-helpers';

/** Only the clock's date is faked: the database driver and HTTP need real timers. */
const setToday = (iso: string) => jest.useFakeTimers({
  now: new Date(iso),
  doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance', 'hrtime'],
});

describe('StartupTN leave policy', () => {
  let env: TestEnv;
  const ledger = (employeeId: string, code: string) =>
    env.db.rows(
      `select l.entry_type, l.days::float as days, l.year, l.note from leave_ledger l join leave_types t on t.id = l.leave_type_id
        where l.employee_id = $1 and t.code = $2 order by l.id`, [employeeId, code]);
  const sum = (rows: { days: number; year: number }[], year: number) =>
    Math.round(rows.filter((r) => r.year === year).reduce((n, r) => n + r.days, 0) * 100) / 100;
  const typeIdSql = async (code: string) => (await env.db.one('select id from leave_types where code = $1', [code]))!.id as string;

  beforeAll(async () => { env = await createTestEnv(); });
  beforeEach(async () => {
    jest.useRealTimers();
    await env.reset();
    await env.db.query('delete from holidays');
    await applyLeavePolicy(env.db);
    env.app.get(SettingsService).invalidate();
    await env.db.query(`update employees set date_of_joining = '2025-01-01', designation = 'Project Lead'`);
  });
  afterAll(async () => { jest.useRealTimers(); await env.close(); });

  it('gives administrative staff their own leave type and everyone else casual leave', async () => {
    await env.db.query(`update employees set designation = 'Office Assistant' where id = $1`, [env.ids.ravi]);
    const codes = async (who: string) => ((await (await env.as(who)).get('/api/leave/types')).body as any[]).map((t) => t.code);
    expect(await codes('priya')).toEqual(expect.arrayContaining(['CL']));
    expect(await codes('priya')).not.toContain('AL');
    expect(await codes('ravi')).toContain('AL');
    expect(await codes('ravi')).not.toContain('CL');
    expect(ADMIN_TITLES).toHaveLength(8);
  });

  it('credits casual leave 1.25 a month from April, and admin leave 1 a month', async () => {
    await env.db.query(`update employees set designation = 'Driver' where id = $1`, [env.ids.ravi]);
    await env.app.get(LeaveService).runAccrual(new Date('2026-06-15T06:00:00Z'));
    const cl = await ledger(env.ids.priya, 'CL');
    expect(cl.filter((l) => l.entry_type === 'accrual' && l.year === 2026).map((l) => [l.note, l.days]))
      .toEqual([['2026-04', 1.25], ['2026-05', 1.25], ['2026-06', 1.25]]);
    const al = await ledger(env.ids.ravi, 'AL');
    expect(al.filter((l) => l.year === 2026).map((l) => l.days)).toEqual([1, 1, 1]);
  });

  it('keeps last year\'s casual leave until 30 June, then lapses it; admin leave lapses on 31 March', async () => {
    await env.db.query(`update employees set designation = 'Driver' where id = $1`, [env.ids.ravi]);
    const leave = env.app.get(LeaveService);
    for (const [who, code] of [[env.ids.priya, 'CL'], [env.ids.ravi, 'AL']] as const) {
      await env.db.query(
        `insert into leave_ledger (employee_id, leave_type_id, year, entry_type, days, note) values ($1,$2,2025,'adjustment',2,'brought forward')`,
        [who, await typeIdSql(code)]);
    }
    // 30 June: casual leave of 2025-26 is still there. Admin leave already lapsed on 31 March.
    await leave.runAccrual(new Date('2026-06-30T06:00:00Z'));
    expect((await ledger(env.ids.priya, 'CL')).some((l) => l.entry_type === 'lapse')).toBe(false);
    const adminLapse = (await ledger(env.ids.ravi, 'AL')).find((l) => l.entry_type === 'lapse');
    expect(adminLapse).toMatchObject({ year: 2025 });
    expect(sum(await ledger(env.ids.ravi, 'AL'), 2025)).toBe(0);

    // 1 July: casual leave lapses, and the whole of last year's balance goes (12 months at 1.25, plus the 2 carried).
    await leave.runAccrual(new Date('2026-07-01T06:00:00Z'));
    const cl = await ledger(env.ids.priya, 'CL');
    expect(cl.find((l) => l.entry_type === 'lapse')).toMatchObject({ year: 2025, days: -17 });
    expect(sum(cl, 2025)).toBe(0);
    await leave.runAccrual(new Date('2026-07-01T06:00:00Z'));
    expect((await ledger(env.ids.priya, 'CL')).filter((l) => l.entry_type === 'lapse')).toHaveLength(1);
  });

  it('uses last year\'s balance first, then this year\'s, and gives both back on cancel', async () => {
    setToday('2026-05-04T06:00:00Z');
    await env.db.query(
      `insert into leave_ledger (employee_id, leave_type_id, year, entry_type, days, note) values ($1,$2,2025,'adjustment',3,'brought forward')`,
      [env.ids.priya, await typeIdSql('CL')]);
    await env.db.query('update approval_workflow_steps set min_days = 99 where min_days = 5'); // one approver is enough here
    const priya = await env.as('priya');
    const before = await balanceOf(priya, 'CL');
    expect(before).toMatchObject({ year: 2026, carriedOver: 18, carriedOverUntil: '2026-06-30', balance: 20.5 });

    const res = await applyLeave(priya, 'CL', '2026-05-11', '2026-06-05');
    expect(res.status).toBe(201);
    expect(res.body.days).toBe(20);
    expect((await decide(await env.as('mani'), res.body.approvalRequestId, 'approve')).body.status).toBe('approved');

    const rows = (await ledger(env.ids.priya, 'CL')).filter((l) => l.entry_type === 'debit');
    expect(rows.map((r) => [r.year, r.days])).toEqual([[2025, -18], [2026, -2]]);
    expect(await balanceOf(priya, 'CL')).toMatchObject({ carriedOver: 0, balance: 0.5 });

    await priya.post(`/api/leave/requests/${res.body.id}/cancel`);
    expect(await balanceOf(priya, 'CL')).toMatchObject({ carriedOver: 18, balance: 20.5 });
  });

  it('does not let last year\'s balance cover leave taken after it has lapsed', async () => {
    setToday('2026-06-20T06:00:00Z');
    await env.db.query(
      `insert into leave_ledger (employee_id, leave_type_id, year, entry_type, days, note) values ($1,$2,2025,'adjustment',3,'brought forward')`,
      [env.ids.priya, await typeIdSql('CL')]);
    const priya = await env.as('priya');
    // 2026 so far: April to June = 3.75 days. Ten days in July must not borrow from last year.
    const res = await applyLeave(priya, 'CL', '2026-07-06', '2026-07-17');
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe('INSUFFICIENT_BALANCE');
  });

  describe('maternity and paternity', () => {
    it('shows maternity leave only to women, paternity only to men, and nothing until gender is set', async () => {
      const codes = async () => ((await (await env.as('priya')).get('/api/leave/types')).body as any[]).map((t) => t.code);
      expect(await codes()).not.toEqual(expect.arrayContaining(['ML']));
      await env.db.query(`update employees set gender = 'female' where id = $1`, [env.ids.priya]);
      expect(await codes()).toEqual(expect.arrayContaining(['ML', 'MSC']));
      expect(await codes()).not.toContain('PL');
      await env.db.query(`update employees set gender = 'male' where id = $1`, [env.ids.priya]);
      expect(await codes()).toContain('PL');
      expect(await codes()).not.toContain('ML');
    });

    it('counts 12 weeks as 84 calendar days, takes nothing from other balances, and allows two children', async () => {
      setToday('2026-05-04T06:00:00Z');
      await env.db.query(`update employees set gender = 'female' where id = $1`, [env.ids.priya]);
      const priya = await env.as('priya');
      const first = await applyLeave(priya, 'ML', '2026-06-01', '2026-08-23');
      expect(first.status).toBe(201);
      expect(first.body.days).toBe(84);
      await decide(await env.as('mani'), first.body.approvalRequestId, 'approve');
      expect((await ledger(env.ids.priya, 'ML')).filter((l) => l.entry_type === 'debit')).toEqual([]);

      const second = await applyLeave(priya, 'ML', '2026-10-01', '2026-12-23');
      expect(second.status).toBe(201);
      const third = await applyLeave(priya, 'ML', '2027-02-01', '2027-04-25');
      expect(third.status).toBe(409);
      expect(third.body.code ?? third.body.error?.code).toBe('LIMIT_REACHED');
    });

    it('refuses more than 84 days at a time and paternity leave before a year of service', async () => {
      setToday('2026-05-04T06:00:00Z');
      await env.db.query(`update employees set gender = 'female' where id = $1`, [env.ids.priya]);
      const tooLong = await applyLeave(await env.as('priya'), 'ML', '2026-06-01', '2026-08-24');
      expect(tooLong.status).toBe(409);

      await env.db.query(`update employees set gender = 'male', date_of_joining = '2025-12-01' where id = $1`, [env.ids.ravi]);
      const early = await applyLeave(await env.as('ravi'), 'PL', '2026-06-01', '2026-06-15');
      expect(early.status).toBe(409);
      await env.db.query(`update employees set date_of_joining = '2025-01-01' where id = $1`, [env.ids.ravi]);
      const ok = await applyLeave(await env.as('ravi'), 'PL', '2026-06-01', '2026-06-15');
      expect(ok.status).toBe(201);
      expect(ok.body.days).toBe(15);
    });
  });

  it('can be loaded twice and refuses to shift leave already taken under calendar years', async () => {
    await applyLeavePolicy(env.db);
    expect((await env.db.one(`select count(*)::int as n from leave_types where code in ('CL','AL','ML','MSC','PL')`))!.n).toBe(5);
    await env.db.query(`update org_settings set value = '1' where key = 'leave_year_start_month'`);
    await env.db.query(
      `insert into leave_ledger (employee_id, leave_type_id, year, entry_type, days, note) values ($1,$2,2026,'debit',-1,'x')`,
      [env.ids.priya, await typeIdSql('CL')]);
    await expect(applyLeavePolicy(env.db)).rejects.toThrow(/--force/);
    await applyLeavePolicy(env.db, { force: true });
  });
});
