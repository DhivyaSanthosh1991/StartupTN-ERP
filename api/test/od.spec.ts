import { addDays, dayOfWeek, istInstant, todayIst } from '../src/common/dates';
import { DayRecalc } from '../src/common/day-recalc.service';
import { OdService } from '../src/od/od.service';
import { futureMonday, recentWeekday } from './dates';
import { TestEnv, createTestEnv } from './helpers';
import { applyLeave, decide, inboxIds } from './leave-helpers';

describe('on duty and permission', () => {
  let env: TestEnv;
  const monday = futureMonday();

  /** Three working days that fall in the same calendar month, for the monthly permission limit. */
  const sameMonthWeekdays = (): string[] => {
    const byMonth = new Map<string, string[]>();
    for (let i = 0; i < 21; i++) {
      const d = addDays(monday, i);
      if (dayOfWeek(d) === 0 || dayOfWeek(d) === 6) continue;
      byMonth.set(d.slice(0, 7), [...(byMonth.get(d.slice(0, 7)) ?? []), d]);
    }
    return [...byMonth.values()].find((days) => days.length >= 3)!;
  };

  const od = (agent: any, body: Record<string, unknown>) =>
    agent.post('/api/od/requests').send({ kind: 'od', purpose: 'Startup summit, Coimbatore', ...body });
  const permission = (agent: any, body: Record<string, unknown>) =>
    agent.post('/api/od/requests').send({ kind: 'permission', purpose: 'Bank work', fromTime: '14:00', toTime: '15:30', ...body });

  let recalcCalls: string[][];

  beforeAll(async () => {
    env = await createTestEnv();
  });
  beforeEach(async () => {
    await env.reset();
    await env.db.query('delete from holidays');
    recalcCalls = [];
    env.app.get(DayRecalc).register(async (_q, employeeId, from, to) => { recalcCalls.push([employeeId, from, to]); });
  });
  afterAll(() => env.close());

  describe('on duty', () => {
    it('creates a pending request for the reporting manager, defaulting to a single day', async () => {
      const priya = await env.as('priya');
      const res = await od(priya, { fromDate: monday, location: 'Coimbatore' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        kind: 'od', status: 'pending', fromDate: monday, toDate: monday, location: 'Coimbatore',
        employeeName: 'Priya Raman', currentApprover: 'Mani Kandan', fromTime: null, minutes: null,
      });
      expect(await inboxIds(await env.as('mani'))).toEqual([res.body.approvalRequestId]);
      const mail = await env.db.one(`select subject from email_outbox where to_address = 'mani@startuptn.in'`);
      expect(mail!.subject).toMatch(/^Approval needed: On duty: .*Priya Raman/);
    });

    it('covers a range, ignoring days off, and tells attendance once approved', async () => {
      const priya = await env.as('priya');
      const res = await od(priya, { fromDate: addDays(monday, 4), toDate: addDays(monday, 7) });
      expect(res.status).toBe(201);
      expect(recalcCalls).toEqual([]);

      expect((await decide(await env.as('mani'), res.body.approvalRequestId, 'approve')).body.status).toBe('approved');
      expect((await priya.get(`/api/od/requests/${res.body.id}`)).body.status).toBe('approved');
      expect(recalcCalls).toEqual([[env.ids.priya, addDays(monday, 4), addDays(monday, 7)]]);
    });

    it('a rejection records the reason and changes nothing in attendance', async () => {
      const priya = await env.as('priya');
      const res = await od(priya, { fromDate: monday });
      await decide(await env.as('mani'), res.body.approvalRequestId, 'reject', 'Please send Ravi instead');
      const after = (await priya.get(`/api/od/requests/${res.body.id}`)).body;
      expect(after).toMatchObject({ status: 'rejected', lastComment: 'Please send Ravi instead' });
      expect(recalcCalls).toEqual([]);
    });

    it('refuses dates that are all days off, bad ranges and over-long ranges', async () => {
      const priya = await env.as('priya');
      expect((await od(priya, { fromDate: addDays(monday, 5), toDate: addDays(monday, 6) })).body.code).toBe('NO_WORKING_DAYS');
      expect((await od(priya, { fromDate: addDays(monday, 3), toDate: monday })).body.code).toBe('BAD_DATES');
      expect((await od(priya, { fromDate: monday, toDate: addDays(monday, 40) })).body.code).toBe('TOO_LONG');
      expect((await od(priya, { fromDate: addDays(todayIst(), -30) })).body.code).toBe('TOO_OLD');
      expect((await od(priya, { fromDate: addDays(todayIst(), 400) })).body.code).toBe('TOO_FAR_AHEAD');
      expect((await od(priya, { fromDate: monday, purpose: 'x' })).body.code).toBe('VALIDATION');
      expect((await od(priya, { fromDate: '2026-02-30' })).body.code).toBe('VALIDATION');
    });

    it('does not allow clashes with other on-duty requests or with leave', async () => {
      const priya = await env.as('priya');
      await od(priya, { fromDate: monday, toDate: addDays(monday, 1) });
      const overlap = await od(priya, { fromDate: addDays(monday, 1), toDate: addDays(monday, 2) });
      expect(overlap.status).toBe(409);
      expect(overlap.body.code).toBe('OVERLAP');

      await applyLeave(priya, 'CL', addDays(monday, 2), addDays(monday, 3));
      const withLeave = await od(priya, { fromDate: addDays(monday, 3) });
      expect(withLeave.status).toBe(409);
      expect(withLeave.body.code).toBe('LEAVE_CONFLICT');

      // Someone else's on duty, or a rejected one, does not get in the way.
      expect((await od(await env.as('ravi'), { fromDate: monday })).status).toBe(201);
    });

    it('can be cancelled before it starts, and then attendance is refreshed again', async () => {
      const priya = await env.as('priya');
      const res = await od(priya, { fromDate: monday });
      await decide(await env.as('mani'), res.body.approvalRequestId, 'approve');
      const cancel = await priya.post(`/api/od/requests/${res.body.id}/cancel`);
      expect(cancel.status).toBe(200);
      expect(cancel.body.status).toBe('cancelled');
      expect(recalcCalls).toHaveLength(2);
      expect((await priya.post(`/api/od/requests/${res.body.id}/cancel`)).body.code).toBe('NOT_CANCELLABLE');
    });

    it('withdraws a pending request and closes its approval', async () => {
      const priya = await env.as('priya');
      const mani = await env.as('mani');
      const res = await od(priya, { fromDate: monday });
      expect((await priya.post(`/api/od/requests/${res.body.id}/cancel`)).body.status).toBe('cancelled');
      expect(await inboxIds(mani)).toEqual([]);
      expect((await decide(mani, res.body.approvalRequestId, 'approve')).body.code).toBe('ALREADY_DECIDED');
    });

    it('once started, only HR can cancel it; colleagues never can', async () => {
      const day = recentWeekday();
      const priya = await env.as('priya');
      const res = await od(priya, { fromDate: day });
      expect(res.status).toBe(201);
      await decide(await env.as('mani'), res.body.approvalRequestId, 'approve');

      expect((await (await env.as('ravi')).post(`/api/od/requests/${res.body.id}/cancel`)).status).toBe(403);
      const own = await priya.post(`/api/od/requests/${res.body.id}/cancel`);
      expect(own.status).toBe(409);
      expect(own.body.code).toBe('ALREADY_STARTED');
      expect((await (await env.as('hema')).post(`/api/od/requests/${res.body.id}/cancel`)).body.status).toBe('cancelled');
    });
  });

  describe('permission', () => {
    it('creates a short-absence request with its length in minutes', async () => {
      const priya = await env.as('priya');
      const res = await permission(priya, { fromDate: monday });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ kind: 'permission', fromDate: monday, toDate: monday, fromTime: '14:00', toTime: '15:30', minutes: 90, status: 'pending' });
      const mail = await env.db.one(`select subject from email_outbox where to_address = 'mani@startuptn.in'`);
      expect(mail!.subject).toMatch(/^Approval needed: Permission: .*14:00–15:30 \(90 min\)/);

      await decide(await env.as('mani'), res.body.approvalRequestId, 'approve');
      expect(recalcCalls).toEqual([[env.ids.priya, monday, monday]]);
    });

    it('validates the times, the length and the day', async () => {
      const priya = await env.as('priya');
      expect((await permission(priya, { fromDate: monday, fromTime: '15:00', toTime: '14:00' })).body.code).toBe('BAD_TIMES');
      expect((await permission(priya, { fromDate: monday, fromTime: '14:00', toTime: '14:00' })).body.code).toBe('BAD_TIMES');
      expect((await permission(priya, { fromDate: monday, fromTime: '14:00', toTime: '16:01' })).body.code).toBe('PERMISSION_TOO_LONG');
      expect((await permission(priya, { fromDate: monday, fromTime: '14:00', toTime: '16:00' })).status).toBe(201); // exactly the limit
      expect((await permission(priya, { fromDate: addDays(monday, 5) })).body.code).toBe('NOT_A_WORKING_DAY');
      expect((await permission(priya, { fromDate: monday, fromTime: '25:00' })).body.code).toBe('VALIDATION');
      expect((await permission(priya, { fromDate: monday, fromTime: undefined })).body.code).toBe('VALIDATION');
      await env.db.query(`insert into holidays (holiday_date, name) values ($1, 'Local holiday')`, [addDays(monday, 1)]);
      expect((await permission(priya, { fromDate: addDays(monday, 1) })).body.code).toBe('NOT_A_WORKING_DAY');
    });

    it('limits how many a person can take in a month, counting pending ones but not rejected', async () => {
      const [d1, d2, d3] = sameMonthWeekdays();
      const month = d1.slice(0, 7);
      const priya = await env.as('priya');
      const mani = await env.as('mani');

      const first = await permission(priya, { fromDate: d1 });
      expect((await permission(priya, { fromDate: d2 })).status).toBe(201);
      const third = await permission(priya, { fromDate: d3 });
      expect(third.status).toBe(409);
      expect(third.body).toMatchObject({ code: 'PERMISSION_LIMIT', used: 2, limit: 2 });
      expect((await priya.get('/api/od/permission-quota').query({ month })).body).toEqual({ month, used: 2, limit: 2, remaining: 0, maxMinutes: 120 });

      await decide(mani, first.body.approvalRequestId, 'reject', 'Please plan around the review');
      expect((await priya.get('/api/od/permission-quota').query({ month })).body).toMatchObject({ used: 1, remaining: 1 });
      expect((await permission(priya, { fromDate: d3 })).status).toBe(201);

      // The limit is per person, and HR can change it.
      expect((await permission(await env.as('ravi'), { fromDate: d1 })).status).toBe(201);
    });

    it('follows the limits HR configures', async () => {
      const hr = await env.as('hema');
      const current = (await hr.get('/api/admin/settings')).body;
      const put = await hr.put('/api/admin/settings').send({ ...current, permission_max_minutes: 60, permission_monthly_limit: 1 });
      expect(put.status).toBe(200);

      const priya = await env.as('priya');
      const [d1, d2] = sameMonthWeekdays();
      expect((await permission(priya, { fromDate: d1, toTime: '15:30' })).body.code).toBe('PERMISSION_TOO_LONG');
      expect((await permission(priya, { fromDate: d1, toTime: '15:00' })).status).toBe(201);
      expect((await permission(priya, { fromDate: d2, toTime: '15:00' })).body.code).toBe('PERMISSION_LIMIT');
    });

    it('refuses overlapping times on one day, but allows back-to-back ones', async () => {
      const hr = await env.as('hema');
      const current = (await hr.get('/api/admin/settings')).body;
      await hr.put('/api/admin/settings').send({ ...current, permission_monthly_limit: 5 });
      const priya = await env.as('priya');

      expect((await permission(priya, { fromDate: monday, fromTime: '14:00', toTime: '15:00' })).status).toBe(201);
      const overlap = await permission(priya, { fromDate: monday, fromTime: '14:30', toTime: '15:30' });
      expect(overlap.status).toBe(409);
      expect(overlap.body.code).toBe('OVERLAP');
      expect((await permission(priya, { fromDate: monday, fromTime: '15:00', toTime: '16:00' })).status).toBe(201);
    });

    it('does not mix with leave or an on-duty day', async () => {
      const priya = await env.as('priya');
      await applyLeave(priya, 'CL', monday, monday);
      expect((await permission(priya, { fromDate: monday })).body.code).toBe('LEAVE_CONFLICT');

      await od(priya, { fromDate: addDays(monday, 1) });
      expect((await permission(priya, { fromDate: addDays(monday, 1) })).body.code).toBe('OD_CONFLICT');
    });

    it('can be cancelled before it starts, and not once it has', async () => {
      const priya = await env.as('priya');
      const future = await permission(priya, { fromDate: monday });
      expect((await priya.post(`/api/od/requests/${future.body.id}/cancel`)).body.status).toBe('cancelled');

      const day = recentWeekday();
      const started = await permission(priya, { fromDate: day, fromTime: '00:00', toTime: '01:00' });
      expect(started.status).toBe(201);
      await decide(await env.as('mani'), started.body.approvalRequestId, 'approve');
      expect((await priya.post(`/api/od/requests/${started.body.id}/cancel`)).body.code).toBe('ALREADY_STARTED');
    });

    it('knows whether a permission later today has begun', () => {
      const svc = env.app.get(OdService) as any;
      const today = todayIst();
      const row = { kind: 'permission', from_date: today, from_time: '23:00:00' };
      expect(svc.hasStarted(row, istInstant(today, '10:00'))).toBe(false);
      expect(svc.hasStarted(row, istInstant(today, '23:00'))).toBe(true);
      expect(svc.hasStarted({ ...row, from_date: addDays(today, 1) }, istInstant(today, '23:59'))).toBe(false);
      expect(svc.hasStarted({ ...row, from_date: addDays(today, -1) }, istInstant(today, '00:01'))).toBe(true);
      expect(svc.hasStarted({ kind: 'od', from_date: today, from_time: null }, istInstant(today, '00:01'))).toBe(true);
    });
  });

  describe('viewing', () => {
    it('lists my requests with a kind filter, and a team view only for managers and HR', async () => {
      const priya = await env.as('priya');
      await od(priya, { fromDate: monday });
      await permission(priya, { fromDate: addDays(monday, 1) });
      await od(await env.as('ravi'), { fromDate: monday });

      expect((await priya.get('/api/od/requests')).body).toHaveLength(2);
      expect((await priya.get('/api/od/requests').query({ kind: 'permission' })).body.map((r: any) => r.kind)).toEqual(['permission']);
      expect((await priya.get('/api/od/requests').query({ from: addDays(monday, 2) })).body).toEqual([]);

      const names = async (who: string, q: object = {}) =>
        ((await (await env.as(who)).get('/api/od/requests/team').query(q)).body as any[]).map((r) => `${r.employeeName}:${r.kind}`).sort();
      expect(await names('mani')).toEqual(['Priya Raman:od', 'Priya Raman:permission', 'Ravi Kumar:od']);
      expect(await names('hema', { kind: 'od' })).toEqual(['Priya Raman:od', 'Ravi Kumar:od']);
      expect(await names('ravi')).toEqual([]);
      expect(await names('arun')).toEqual([]);
    });

    it('shows one request to its owner, their reporting line and HR only', async () => {
      const res = await od(await env.as('priya'), { fromDate: monday });
      for (const who of ['priya', 'mani', 'hari', 'hema']) expect((await (await env.as(who)).get(`/api/od/requests/${res.body.id}`)).status).toBe(200);
      for (const who of ['ravi', 'arun']) expect((await (await env.as(who)).get(`/api/od/requests/${res.body.id}`)).status).toBe(403);
      expect((await (await env.as('hema')).get('/api/od/requests/11111111-1111-4111-8111-111111111111')).status).toBe(404);
    });

    it('needs a signed-in user and a sensible quota month', async () => {
      expect((await env.anon().get('/api/od/requests')).status).toBe(401);
      expect((await (await env.as('priya')).get('/api/od/permission-quota').query({ month: '2026-13' })).status).toBe(400);
      expect((await (await env.as('priya')).get('/api/od/permission-quota')).body).toMatchObject({ month: todayIst().slice(0, 7), used: 0, limit: 2 });
    });
  });
});
