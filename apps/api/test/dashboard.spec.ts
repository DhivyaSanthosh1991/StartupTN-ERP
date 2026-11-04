import { SettingsService } from '../src/common/settings.service';
import { addDays, todayIst } from '../src/common/dates';
import { futureMonday } from './dates';
import { TestEnv, createTestEnv } from './helpers';
import { applyLeave, typeId } from './leave-helpers';

describe('dashboard', () => {
  let env: TestEnv;
  const today = todayIst();

  const home = async (who: string) => (await (await env.as(who)).get('/api/dashboard')).body;

  /** An approved leave or duty row, written straight to the database so the test does not depend on the weekday. */
  const approvedLeave = async (who: keyof typeof env.ids, from: string, to: string, dayPart = 'full', code = 'CL') => {
    const type = await env.db.one('select id from leave_types where code = $1', [code]);
    await env.db.query(
      `insert into leave_requests (employee_id, leave_type_id, from_date, to_date, day_part, days, reason, status)
       values ($1, $2, $3, $4, $5, 1, 'Personal', 'approved')`, [env.ids[who], type!.id, from, to, dayPart]);
  };
  const approvedOd = (who: keyof typeof env.ids, from: string, to: string, kind = 'od') =>
    env.db.query(
      `insert into od_requests (employee_id, kind, from_date, to_date, from_time, to_time, location, purpose, status)
       values ($1, $2, $3, $4, $5, $6, 'Madurai', 'Incubator visit', 'approved')`,
      [env.ids[who], kind, from, kind === 'od' ? to : from, kind === 'od' ? null : '10:00', kind === 'od' ? null : '11:00']);

  beforeAll(async () => {
    env = await createTestEnv();
  });
  beforeEach(async () => {
    await env.reset();
    await env.db.query('delete from holidays');
    await env.db.query('delete from notices');
  });
  afterAll(() => env.close());

  it('needs a signed-in user', async () => {
    expect((await env.anon().get('/api/dashboard')).status).toBe(401);
  });

  it('gives a new joiner a complete, quiet home page', async () => {
    const d = await home('priya');
    expect(d.date).toBe(today);
    expect(d.attendance).toMatchObject({ date: today, state: 'not_started', canCheckIn: true, canCheckOut: false, locationConsent: false });
    expect(d.month.month).toBe(today.slice(0, 7));
    expect(d.month.summary).toEqual(expect.objectContaining({ present: expect.any(Number), late: expect.any(Number) }));
    expect(d.leaveBalances.map((b: any) => b.code)).toEqual(expect.arrayContaining(['CL', 'LOP']));
    expect(d.myRequests).toEqual({ pending: { leave: 0, od: 0, permission: 0, regularisation: 0, total: 0 }, upcoming: [] });
    expect(d.approvals).toEqual({ waiting: 0, overdue: 0, oldest: [] });
    expect(d.team).toBeNull();
    expect(d.awayToday).toEqual([]);
    expect(d.holidays).toEqual([]);
    expect(d.notices).toEqual([]);
    expect(d.expiringDocuments).toEqual([]);
  });

  describe('my requests', () => {
    it('counts what is still waiting, by kind', async () => {
      const priya = await env.as('priya');
      const monday = futureMonday();
      expect((await applyLeave(priya, 'CL', monday, monday)).status).toBe(201);
      expect((await priya.post('/api/od/requests').send({ kind: 'od', fromDate: addDays(monday, 1), toDate: addDays(monday, 1), location: 'Madurai hub', purpose: 'Visit' })).status).toBe(201);
      expect((await priya.post('/api/od/requests').send({ kind: 'permission', fromDate: addDays(monday, 2), toDate: addDays(monday, 2), fromTime: '10:00', toTime: '11:00', purpose: 'Bank' })).status).toBe(201);

      const d = await home('priya');
      expect(d.myRequests.pending).toEqual({ leave: 1, od: 1, permission: 1, regularisation: 0, total: 3 });
      // Waiting leave is held against the balance.
      expect(d.leaveBalances.find((b: any) => b.code === 'CL').pending).toBe(1);
    });

    it('lists the next approved leave and duty, soonest first, and nothing that has ended', async () => {
      await approvedLeave('priya', addDays(today, -10), addDays(today, -9));
      await approvedLeave('priya', addDays(today, 20), addDays(today, 21));
      await approvedOd('priya', addDays(today, 5), addDays(today, 6));
      await approvedOd('priya', addDays(today, 8), addDays(today, 8), 'permission');
      await env.db.query(`update od_requests set status = 'pending' where kind = 'permission'`);

      const { upcoming } = (await home('priya')).myRequests;
      expect(upcoming.map((u: any) => [u.kind, u.from, u.to])).toEqual([
        ['od', addDays(today, 5), addDays(today, 6)],
        ['leave', addDays(today, 20), addDays(today, 21)],
      ]);
      expect(upcoming[1].label).toBe('Casual Leave');
      expect(upcoming[0].label).toBe('Madurai');
    });

    it('keeps a leave that is under way today in the list', async () => {
      await approvedLeave('priya', addDays(today, -1), addDays(today, 1));
      expect((await home('priya')).myRequests.upcoming).toHaveLength(1);
    });

    it('does not show anyone else\'s requests', async () => {
      await approvedLeave('ravi', addDays(today, 3), addDays(today, 4));
      expect((await home('priya')).myRequests.upcoming).toEqual([]);
    });
  });

  describe('approvals waiting', () => {
    it('shows an approver what is waiting and how much is overdue', async () => {
      const monday = futureMonday();
      await applyLeave(await env.as('priya'), 'CL', monday, monday);
      await applyLeave(await env.as('ravi'), 'CL', addDays(monday, 1), addDays(monday, 1));

      let d = await home('mani');
      expect(d.approvals.waiting).toBe(2);
      expect(d.approvals.overdue).toBe(0);
      expect(d.approvals.oldest).toHaveLength(2);
      expect(d.approvals.oldest[0]).toEqual(expect.objectContaining({ typeLabel: 'Leave', requester: expect.stringMatching(/Priya Raman|Ravi Kumar/) }));
      expect((await home('priya')).approvals.waiting).toBe(0); // you do not approve your own

      await env.db.query(`update approval_steps set due_at = now() - interval '1 hour' where status = 'pending'`);
      d = await home('mani');
      expect(d.approvals.overdue).toBe(2);
    });

    it('lists at most the three oldest', async () => {
      const monday = futureMonday();
      const priya = await env.as('priya');
      for (let i = 0; i < 4; i++) await priya.post('/api/od/requests').send({ kind: 'od', fromDate: addDays(monday, i), toDate: addDays(monday, i), location: 'Venue X', purpose: `Visit ${i}` });
      const d = await home('mani');
      expect(d.approvals.waiting).toBe(4);
      expect(d.approvals.oldest).toHaveLength(3);
    });
  });

  describe('holidays and notices', () => {
    it('shows the next five holidays within four months', async () => {
      for (const [offset, name] of [[-3, 'Past'], [2, 'One'], [9, 'Two'], [16, 'Three'], [23, 'Four'], [30, 'Five'], [37, 'Six'], [200, 'Far']] as const) {
        await env.db.query('insert into holidays (holiday_date, name) values ($1, $2)', [addDays(today, offset), name]);
      }
      const d = await home('priya');
      expect(d.holidays.map((h: any) => h.name)).toEqual(['One', 'Two', 'Three', 'Four', 'Five']);
      expect(d.holidays[0]).toEqual({ date: addDays(today, 2), name: 'One', optional: false });
      expect((await env.db.one(`select 1 as x from holidays where name = 'Far'`))).not.toBeNull();
    });

    it('shows live notices, newest first, and hides expired ones', async () => {
      await env.db.query(`insert into notices (title, body, published_at) values ('Older', 'b', now() - interval '2 days')`);
      await env.db.query(`insert into notices (title, body) values ('Newest', 'b')`);
      await env.db.query(`insert into notices (title, body, expires_on) values ('Expired', 'b', $1)`, [addDays(today, -1)]);
      await env.db.query(`insert into notices (title, body, expires_on) values ('Until today', 'b', $1)`, [today]);
      const d = await home('priya');
      expect(d.notices.map((n: any) => n.title)).toEqual(expect.arrayContaining(['Newest', 'Older', 'Until today']));
      expect(d.notices.map((n: any) => n.title)).not.toContain('Expired');
      expect(d.notices.at(-1).title).toBe('Older');
    });

    it('shows at most five notices', async () => {
      for (let i = 0; i < 7; i++) await env.db.query(`insert into notices (title, body) values ($1, 'b')`, [`Notice ${i}`]);
      expect((await home('priya')).notices).toHaveLength(5);
    });
  });

  describe('who is away today', () => {
    it('shows colleagues in my department and my reporting line, and only that they are away', async () => {
      await approvedLeave('ravi', today, today);
      await approvedOd('manager', today, today);
      await approvedLeave('analyst', today, today); // another department, no link to Priya

      const away = (await home('priya')).awayToday;
      expect(away.map((a: any) => [a.fullName, a.away, a.dayPart])).toEqual([['Mani Kandan', 'od', 'full'], ['Ravi Kumar', 'leave', 'full']]);
      expect(Object.keys(away[0]).sort()).toEqual(['away', 'dayPart', 'designation', 'employeeId', 'fullName']); // no leave type, no reason
    });

    it('shows a manager their direct reports, and half days as such', async () => {
      await approvedLeave('priya', today, today, 'first_half');
      const away = (await home('mani')).awayToday;
      expect(away.map((a: any) => [a.fullName, a.dayPart])).toEqual([['Priya Raman', 'first_half']]);
    });

    it('leaves out the person looking, pending requests, past leave, and anyone who has left', async () => {
      await approvedLeave('priya', today, today);
      await approvedLeave('ravi', addDays(today, -3), addDays(today, -1));
      await approvedLeave('manager', addDays(today, 1), addDays(today, 2));
      await env.db.query(`update leave_requests set status = 'pending' where employee_id = $1`, [env.ids.manager]);
      expect((await home('priya')).awayToday).toEqual([]);

      await env.db.query(`update employees set status = 'exited' where id = $1`, [env.ids.priya]);
      expect((await home('ravi')).awayToday).toEqual([]);
    });

    it('is empty for someone with no department and no team', async () => {
      await approvedLeave('ravi', today, today);
      expect((await home('sathya')).awayToday).toEqual([]);
    });
  });

  describe('team today', () => {
    beforeEach(async () => {
      // Make every day a working day so the counts do not depend on the weekday the suite runs on.
      await env.db.query(`insert into org_settings (key, value) values ('weekly_off_days', '[]'::jsonb)
                          on conflict (key) do update set value = excluded.value`);
      env.app.get(SettingsService).invalidate();
    });

    it('is only for people who look after others', async () => {
      expect((await home('priya')).team).toBeNull();
      expect((await home('divya')).team).toBeNull();
    });

    it('counts a manager\'s people by what they are doing today', async () => {
      expect((await home('mani')).team).toEqual({ total: 2, present: 0, checkedInNow: 0, onLeave: 0, onDuty: 0, dayOff: 0, notYetIn: 2 });

      await approvedLeave('ravi', today, today);
      await env.db.query('update employees set location_consent_at = now() where id = $1', [env.ids.priya]);
      const priya = await env.as('priya');
      expect((await priya.post('/api/attendance/check-in').send({ latitude: 13.0827, longitude: 80.2707, accuracyM: 10 })).status).toBe(200);
      expect((await home('mani')).team).toEqual({ total: 2, present: 1, checkedInNow: 1, onLeave: 1, onDuty: 0, dayOff: 0, notYetIn: 0 });

      // Once she checks out she is still counted as in today, but no longer as in the office now.
      expect((await priya.post('/api/attendance/check-out').send({ latitude: 13.0827, longitude: 80.2707, accuracyM: 10 })).status).toBe(200);
      expect((await home('mani')).team).toMatchObject({ present: 1, checkedInNow: 0 });
    });

    it('counts on-duty people, half-day leave before arrival, and holidays', async () => {
      await approvedOd('priya', today, today);
      await approvedLeave('ravi', today, today, 'second_half');
      expect((await home('mani')).team).toMatchObject({ total: 2, onDuty: 1, onLeave: 1, notYetIn: 0 });

      await env.db.query('delete from od_requests');
      await env.db.query('delete from leave_requests');
      await env.db.query('insert into holidays (holiday_date, name) values ($1, $2)', [today, 'Festival']);
      expect((await home('mani')).team).toEqual({ total: 2, present: 0, checkedInNow: 0, onLeave: 0, onDuty: 0, dayOff: 2, notYetIn: 0 });
    });

    it('gives HR everyone but themselves', async () => {
      const others = await env.db.one(`select count(*)::int as n from employees where status = 'active' and id <> $1`, [env.ids.hr]);
      expect((await home('hema')).team.total).toBe(others!.n);
    });
  });

  describe('expiring documents', () => {
    it('warns about my own documents that run out within a month, but not HR-only ones', async () => {
      const priya = await env.as('priya');
      const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
      const add = async (agent: any, extra: Record<string, unknown>) => {
        const c = await agent.post('/api/documents').send({ categoryCode: 'certificate', title: 'Cert', fileName: 'c.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, ...extra });
        await agent.put(c.body.upload.url).set(c.body.upload.headers).send(PDF);
        await agent.post(`/api/documents/${c.body.document.id}/complete`);
      };
      await add(priya, { title: 'Soon', expiresOn: addDays(today, 10) });
      await add(priya, { title: 'Later', expiresOn: addDays(today, 90) });
      await add(await env.as('hema'), { employeeId: env.ids.priya, title: 'Private', expiresOn: addDays(today, 3), visibility: 'hr_only' });

      const d = await home('priya');
      expect(d.expiringDocuments.map((x: any) => x.title)).toEqual(['Soon']);
    });
  });

  it('shows the same numbers the leave screen does', async () => {
    const priya = await env.as('priya');
    const monday = futureMonday();
    await applyLeave(priya, 'CL', monday, monday);
    const screen = (await priya.get('/api/leave/balances')).body;
    expect((await home('priya')).leaveBalances).toEqual(screen);
    expect(typeof (await typeId(priya, 'CL'))).toBe('string');
  });
});
