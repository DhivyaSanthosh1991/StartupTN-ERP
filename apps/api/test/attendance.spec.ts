import { AuthUser } from '../src/common/auth.types';
import { addDays, istInstant, todayIst } from '../src/common/dates';
import { AttendanceService } from '../src/attendance/attendance.service';
import { DemoIds } from '../src/db/seed';
import { futureMonday, pastMonday, previousWeekday, recentWeekday } from './dates';
import { TestEnv, createTestEnv } from './helpers';
import { applyLeave, decide } from './leave-helpers';

const OFFICE = { latitude: 13.0827, longitude: 80.2707 };
const TWO_KM_AWAY = { latitude: 13.1007, longitude: 80.2707 };
const BENGALURU = { latitude: 12.9716, longitude: 77.5946 };

describe('attendance and GPS tagging', () => {
  let env: TestEnv;
  let att: AttendanceService;
  const monday = pastMonday();
  const tuesday = addDays(monday, 1);

  const user = async (key: keyof DemoIds): Promise<AuthUser> => {
    const r = (await env.db.one(
      'select id, emp_code, full_name, official_email, department_id, reporting_manager_id from employees where id = $1', [env.ids[key]]))!;
    return { id: r.id, empCode: r.emp_code, fullName: r.full_name, email: r.official_email, roles: [], departmentId: r.department_id, reportingManagerId: r.reporting_manager_id };
  };
  const consentAll = () => env.db.query('update employees set location_consent_at = now()');

  /** Punches through the service at a chosen time on a chosen (past) date. */
  const punchAt = async (who: keyof DemoIds, kind: 'check_in' | 'check_out', hhmm: string, date = monday, loc: { latitude: number; longitude: number } = OFFICE, accuracyM = 10) =>
    att.punch(await user(who), kind, { ...loc, accuracyM, source: 'web' }, istInstant(date, hhmm));

  const dayOf = async (agent: any, date: string) =>
    (await agent.get('/api/attendance/me').query({ month: date.slice(0, 7) })).body.days.find((d: any) => d.date === date);
  const storedDay = (id: string, date: string) => env.db.one('select * from attendance_days where employee_id = $1 and work_date = $2', [id, date]);

  const punch = (agent: any, kind: 'check-in' | 'check-out', body: Record<string, unknown> = {}) =>
    agent.post(`/api/attendance/${kind}`).send({ ...OFFICE, accuracyM: 12, ...body });

  beforeAll(async () => {
    env = await createTestEnv();
    att = env.app.get(AttendanceService);
  });
  beforeEach(async () => {
    await env.reset();
    await env.db.query('delete from holidays');
  });
  afterAll(() => env.close());

  describe('punching in and out', () => {
    it('needs the employee\'s location consent first', async () => {
      const priya = await env.as('priya');
      const refused = await punch(priya, 'check-in');
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('LOCATION_CONSENT_REQUIRED');
      expect((await priya.get('/api/attendance/today')).body.locationConsent).toBe(false);

      await priya.post('/api/me/location-consent');
      const ok = await punch(priya, 'check-in');
      expect(ok.status).toBe(200);
      expect(ok.body.locationConsent).toBe(true);
    });

    it('records the GPS fix against the nearest fence, using the server\'s clock', async () => {
      await consentAll();
      const priya = await env.as('priya');
      const res = await punch(priya, 'check-in', { eventAt: '2020-01-01T00:00:00Z', source: 'mobile' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ state: 'checked_in', canCheckIn: false, canCheckOut: true });
      const [event] = res.body.events;
      expect(event).toMatchObject({ type: 'check_in', withinGeofence: true, geofenceName: expect.stringContaining('Demo office'), flags: [], source: 'mobile', accuracyM: 12 });
      expect(Math.abs(Date.now() - new Date(event.at).getTime())).toBeLessThan(10_000);
      expect(event.latitude).toBeCloseTo(OFFICE.latitude, 6);
    });

    it('lets people punch from outside the fence but flags it for review', async () => {
      await consentAll();
      const res = await punch(await env.as('priya'), 'check-in', TWO_KM_AWAY);
      expect(res.status).toBe(200);
      expect(res.body.events[0]).toMatchObject({ withinGeofence: false, flags: ['outside_geofence'] });
      expect(res.body.day.flags).toContain('outside_geofence');
    });

    it('flags a weak GPS fix and refuses a useless one', async () => {
      await consentAll();
      const priya = await env.as('priya');
      const weak = await punch(priya, 'check-in', { accuracyM: 150 });
      expect(weak.body.events[0].flags).toEqual(['low_accuracy']);

      const useless = await punch(await env.as('ravi'), 'check-in', { accuracyM: 900 });
      expect(useless.status).toBe(400);
      expect(useless.body.code).toBe('GPS_TOO_INACCURATE');
      expect((await (await env.as('ravi')).get('/api/attendance/today')).body.events).toEqual([]);
    });

    it('notes when no office location has been set up yet', async () => {
      await consentAll();
      await env.db.query('delete from geofences');
      const res = await punch(await env.as('priya'), 'check-in');
      expect(res.body.events[0]).toMatchObject({ withinGeofence: null, flags: ['no_geofence'] });
    });

    it('follows in, out, in, out — and refuses a repeat or an out of turn', async () => {
      await consentAll();
      const priya = await env.as('priya');
      const noIn = await punch(priya, 'check-out');
      expect(noIn.status).toBe(409);
      expect(noIn.body.code).toBe('NOT_CHECKED_IN');

      await punch(priya, 'check-in');
      const twice = await punch(priya, 'check-in');
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('ALREADY_CHECKED_IN');

      expect((await punch(priya, 'check-out')).body.state).toBe('checked_out');
      await punch(priya, 'check-in');
      const last = await punch(priya, 'check-out');
      expect(last.body.events.map((e: any) => e.type)).toEqual(['check_in', 'check_out', 'check_in', 'check_out']);
    });

    it('survives a double-click: only one of two simultaneous check-ins counts', async () => {
      await consentAll();
      const priya = await user('priya');
      const input = { ...OFFICE, accuracyM: 10, source: 'web' as const };
      const results = await Promise.allSettled([att.punch(priya, 'check_in', input), att.punch(priya, 'check_in', input)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.getResponse() as any).code).toBe('ALREADY_CHECKED_IN');
      expect(await env.db.rows('select 1 from attendance_events')).toHaveLength(1);
    });

    it('flags a jump that no vehicle could make, but not ordinary movement', async () => {
      await consentAll();
      await punchAt('priya', 'check_in', '09:00');
      await punchAt('priya', 'check_out', '09:30', monday, BENGALURU);
      await punchAt('ravi', 'check_in', '09:00');
      await punchAt('ravi', 'check_out', '11:00', monday, TWO_KM_AWAY);
      const flagsOf = async (key: keyof DemoIds) =>
        (await env.db.rows(`select flags from attendance_events where employee_id = $1 and event_type = 'check_out'`, [env.ids[key]])).map((r) => r.flags);
      expect((await flagsOf('priya'))[0]).toEqual(expect.arrayContaining(['impossible_travel', 'outside_geofence']));
      expect((await flagsOf('ravi'))[0]).toEqual(['outside_geofence']);
    });

    it('rejects malformed locations and needs a signed-in user', async () => {
      await consentAll();
      const priya = await env.as('priya');
      for (const body of [{ latitude: 91 }, { longitude: 181 }, { latitude: '13.08' }, { latitude: undefined }, { accuracyM: -5 }]) {
        expect((await punch(priya, 'check-in', body)).body.code).toBe('VALIDATION');
      }
      expect((await env.anon().post('/api/attendance/check-in').send(OFFICE)).status).toBe(401);
      expect((await env.anon().get('/api/attendance/today')).status).toBe(401);
    });

    it('describes today for the punch screen', async () => {
      await env.db.query(`insert into holidays (holiday_date, name) values ($1, 'Founders Day')`, [todayIst()]);
      const res = await (await env.as('priya')).get('/api/attendance/today');
      expect(res.body).toMatchObject({ date: todayIst(), state: 'not_started', canCheckIn: true, canCheckOut: false, info: { holiday: 'Founders Day', leave: null, od: false } });
      expect(res.body.day).toMatchObject({ status: 'holiday' });
    });
  });

  describe('working out the day', () => {
    it('present and on time for a full day', async () => {
      await consentAll();
      await punchAt('priya', 'check_in', '09:20');
      await punchAt('priya', 'check_out', '18:00');
      const d = await dayOf(await env.as('priya'), monday);
      expect(d).toMatchObject({ status: 'present', late: false, workedMinutes: 520, holiday: null });
      expect(await storedDay(env.ids.priya, monday)).toMatchObject({ status: 'present', worked_minutes: 520, late: false });
    });

    it('late, half day and short day', async () => {
      await consentAll();
      await punchAt('priya', 'check_in', '09:50'); await punchAt('priya', 'check_out', '18:30');
      await punchAt('ravi', 'check_in', '09:00'); await punchAt('ravi', 'check_out', '13:30');
      await punchAt('opsHead', 'check_in', '09:00'); await punchAt('opsHead', 'check_out', '11:00');
      expect(await dayOf(await env.as('priya'), monday)).toMatchObject({ status: 'present', late: true });
      expect(await dayOf(await env.as('ravi'), monday)).toMatchObject({ status: 'half_day', workedMinutes: 270 });
      expect(await dayOf(await env.as('hari'), monday)).toMatchObject({ status: 'absent', flags: ['short_hours'] });
    });

    it('a missed check-out shows as incomplete, not absent', async () => {
      await consentAll();
      await punchAt('priya', 'check_in', '09:30');
      expect(await dayOf(await env.as('priya'), monday)).toMatchObject({ status: 'incomplete', flags: ['missing_checkout'] });
      expect(await storedDay(env.ids.priya, monday)).toMatchObject({ status: 'incomplete' });
    });

    it('shows days off and absences for days with no punches', async () => {
      await env.db.query(`insert into holidays (holiday_date, name) values ($1, 'Test holiday')`, [tuesday]);
      const priya = await env.as('priya');
      const month = (await priya.get('/api/attendance/me').query({ month: monday.slice(0, 7) })).body;
      const by = Object.fromEntries(month.days.map((d: any) => [d.date, d]));
      expect(by[monday].status).toBe('absent');
      expect(by[tuesday]).toMatchObject({ status: 'holiday', holiday: 'Test holiday' });
      expect(by[addDays(monday, 5)].status).toBe('weekly_off');
      expect(month.summary.absent).toBeGreaterThan(0);

      // Later days of the current month: nothing is shown ahead of time, apart from weekly offs.
      const current = (await priya.get('/api/attendance/me')).body.days.filter((d: any) => d.date > todayIst());
      for (const d of current) expect(d.status === null || d.status === 'weekly_off').toBe(true);
    });

    it('approved leave, on-duty and permission change the day', async () => {
      await consentAll();
      const priya = await env.as('priya');
      const mani = await env.as('mani');
      const day = recentWeekday();

      const leave = await applyLeave(priya, 'CL', day, day);
      expect(leave.status).toBe(201);
      expect((await dayOf(priya, day)).status).not.toBe('leave'); // pending: not yet
      await decide(mani, leave.body.approvalRequestId, 'approve');
      expect(await dayOf(priya, day)).toMatchObject({ status: 'leave' });
      expect(await storedDay(env.ids.priya, day)).toMatchObject({ status: 'leave' });

      await priya.post(`/api/leave/requests/${leave.body.id}/cancel`).send(); // HR-only once started
      expect((await dayOf(priya, day)).status).toBe('leave');

      const hr = await env.as('hema');
      await hr.post(`/api/leave/requests/${leave.body.id}/cancel`).send();
      expect((await dayOf(priya, day)).status).not.toBe('leave');

      const ravi = await env.as('ravi');
      const od = await ravi.post('/api/od/requests').send({ kind: 'od', fromDate: day, location: 'Partner office, Madurai', purpose: 'Partner visit' });
      await decide(mani, od.body.approvalRequestId, 'approve');
      expect(await dayOf(ravi, day)).toMatchObject({ status: 'od' });
      expect(await storedDay(env.ids.ravi, day)).toMatchObject({ status: 'od' });
    });

    it('plans ahead: approved future leave shows without being stored', async () => {
      const priya = await env.as('priya');
      const next = futureMonday();
      const leave = await applyLeave(priya, 'CL', next, addDays(next, 1));
      await decide(await env.as('mani'), leave.body.approvalRequestId, 'approve');
      const d = await dayOf(priya, next);
      expect(d.status).toBe('leave');
      expect(await storedDay(env.ids.priya, next)).toBeNull();
    });

    it('half-day leave needs only the other half worked', async () => {
      await consentAll();
      const day = recentWeekday();
      const ravi = await env.as('ravi');
      const leave = await applyLeave(ravi, 'CL', day, day, { dayPart: 'first_half' });
      await decide(await env.as('mani'), leave.body.approvalRequestId, 'approve');
      expect(await dayOf(ravi, day)).toMatchObject({ status: 'half_day', flags: expect.arrayContaining(['half_day_leave']) });
    });

    it('does not show days before joining or after leaving', async () => {
      await env.db.query(`update employees set date_of_joining = $2, exit_date = $3 where id = $1`, [env.ids.priya, tuesday, addDays(monday, 3)]);
      const priya = await env.as('priya');
      const by = Object.fromEntries((await priya.get('/api/attendance/me').query({ month: monday.slice(0, 7) })).body.days.map((d: any) => [d.date, d.status]));
      expect(by[monday]).toBeNull();
      expect(by[tuesday]).toBe('absent');
      expect(by[addDays(monday, 3)]).toBe('absent');
      expect(by[addDays(monday, 4)]).toBeNull();
    });
  });

  describe('corrections (regularisation)', () => {
    const reg = (agent: any, body: Record<string, unknown>) =>
      agent.post('/api/attendance/regularisations').send({ workDate: tuesday, reason: 'Forgot to punch', ...body });

    it('a full correction replaces the day\'s punches once approved, and the GPS record is kept', async () => {
      await consentAll();
      await punchAt('priya', 'check_in', '09:40', tuesday, TWO_KM_AWAY);
      await punchAt('priya', 'check_out', '13:40', tuesday);
      const priya = await env.as('priya');
      expect((await dayOf(priya, tuesday)).status).toBe('half_day');

      const res = await reg(priya, { checkInTime: '09:30', checkOutTime: '18:00' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'pending', checkInTime: '09:30', checkOutTime: '18:00', currentApprover: 'Mani Kandan' });
      expect((await dayOf(priya, tuesday)).status).toBe('half_day'); // nothing changes until approved

      expect((await decide(await env.as('mani'), res.body.approvalRequestId, 'approve')).body.status).toBe('approved');
      expect(await dayOf(priya, tuesday)).toMatchObject({ status: 'present', workedMinutes: 510, late: false, flags: ['regularised'] });
      expect(await storedDay(env.ids.priya, tuesday)).toMatchObject({ status: 'present', worked_minutes: 510 });

      const trail = (await (await env.as('mani')).get('/api/attendance/trail').query({ employeeId: env.ids.priya, date: tuesday })).body;
      expect(trail).toHaveLength(4);
      expect(trail.filter((e: any) => e.flags.includes('superseded'))).toHaveLength(2);
      expect(trail.filter((e: any) => e.source === 'regularisation')).toHaveLength(2);
    });

    it('a missing check-out can be added on its own', async () => {
      await consentAll();
      await punchAt('priya', 'check_in', '09:30', tuesday);
      const priya = await env.as('priya');
      expect((await dayOf(priya, tuesday)).status).toBe('incomplete');
      const res = await reg(priya, { checkOutTime: '18:00' });
      await decide(await env.as('mani'), res.body.approvalRequestId, 'approve');
      expect(await dayOf(priya, tuesday)).toMatchObject({ status: 'present', workedMinutes: 510 });
    });

    it('a single time that does not fit the punches is turned away', async () => {
      await consentAll();
      await punchAt('priya', 'check_in', '09:30', tuesday);
      await punchAt('priya', 'check_out', '18:00', tuesday);
      const priya = await env.as('priya');
      const res = await reg(priya, { checkOutTime: '19:00' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CORRECTION_NO_EFFECT');
      // ...and with no punches at all, one time alone cannot make a day either.
      expect((await reg(await env.as('ravi'), { checkInTime: '09:30' })).body.code).toBe('CORRECTION_NO_EFFECT');
    });

    it('a rejection changes nothing, and a pending one can be withdrawn but an applied one cannot', async () => {
      const priya = await env.as('priya');
      const mani = await env.as('mani');
      const first = await reg(priya, { checkInTime: '09:30', checkOutTime: '18:00' });
      expect((await reg(priya, { checkInTime: '09:00', checkOutTime: '17:00' })).body.code).toBe('ALREADY_PENDING');
      await decide(mani, first.body.approvalRequestId, 'reject', 'No record of you being in');
      expect((await dayOf(priya, tuesday)).status).toBe('absent');
      expect((await priya.get(`/api/attendance/regularisations/${first.body.id}`)).body).toMatchObject({ status: 'rejected', lastComment: 'No record of you being in' });

      const second = await reg(priya, { checkInTime: '09:30', checkOutTime: '18:00' });
      expect((await priya.post(`/api/attendance/regularisations/${second.body.id}/cancel`)).body.status).toBe('cancelled');

      const third = await reg(priya, { checkInTime: '09:30', checkOutTime: '18:00' });
      await decide(mani, third.body.approvalRequestId, 'approve');
      const late = await priya.post(`/api/attendance/regularisations/${third.body.id}/cancel`);
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('NOT_CANCELLABLE');
    });

    it('enforces the rules about dates and times', async () => {
      const priya = await env.as('priya');
      const code = async (body: Record<string, unknown>) => (await reg(priya, body)).body.code;
      expect(await code({ checkInTime: '09:30', checkOutTime: '09:30' })).toBe('BAD_TIMES');
      expect(await code({})).toBe('TIMES_REQUIRED');
      expect(await code({ checkInTime: '9.30' })).toBe('VALIDATION');
      expect(await code({ workDate: addDays(todayIst(), 1), checkInTime: '09:30', checkOutTime: '18:00' })).toBe('FUTURE_DATE');
      expect(await code({ workDate: addDays(todayIst(), -16), checkInTime: '09:30', checkOutTime: '18:00' })).toBe('TOO_OLD');
      expect(await code({ workDate: todayIst(), checkInTime: '09:00', checkOutTime: '23:59' })).toBe('FUTURE_TIME');

      await env.db.query(`update employees set date_of_joining = $2 where id = $1`, [env.ids.priya, todayIst()]);
      expect(await code({ checkInTime: '09:30', checkOutTime: '18:00' })).toBe('NOT_EMPLOYED');
    });

    it('follows the window HR configures', async () => {
      const hr = await env.as('hema');
      const current = (await hr.get('/api/admin/settings')).body;
      await hr.put('/api/admin/settings').send({ regularisation_window_days: 3 });
      expect(current.regularisation_window_days).toBe(15);
      const res = await reg(await env.as('priya'), { workDate: monday, checkInTime: '09:30', checkOutTime: '18:00' });
      expect(res.body.code).toBe('TOO_OLD');
    });

    it('is refused for a day already covered by leave or on duty', async () => {
      const day = previousWeekday();
      const priya = await env.as('priya');
      await applyLeave(priya, 'CL', day, day);
      const res = await reg(priya, { workDate: day, checkInTime: '09:30', checkOutTime: '18:00' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DAY_COVERED');
    });

    it('is visible to the employee, their managers and HR only', async () => {
      const res = await reg(await env.as('priya'), { checkInTime: '09:30', checkOutTime: '18:00' });
      for (const who of ['priya', 'mani', 'hari', 'hema']) expect((await (await env.as(who)).get(`/api/attendance/regularisations/${res.body.id}`)).status).toBe(200);
      for (const who of ['ravi', 'arun']) expect((await (await env.as(who)).get(`/api/attendance/regularisations/${res.body.id}`)).status).toBe(403);
      expect((await (await env.as('mani')).get('/api/attendance/regularisations/team')).body).toHaveLength(1);
      expect((await (await env.as('ravi')).get('/api/attendance/regularisations/team')).body).toEqual([]);
      expect((await (await env.as('priya')).get('/api/attendance/regularisations')).body).toHaveLength(1);
    });
  });

  describe('team views, review and reports', () => {
    beforeEach(async () => {
      await consentAll();
      await punchAt('priya', 'check_in', '09:20'); await punchAt('priya', 'check_out', '18:00');
      await punchAt('ravi', 'check_in', '09:50', monday, TWO_KM_AWAY); await punchAt('ravi', 'check_out', '18:30');
    });

    it('a manager sees their team\'s day; a colleague sees nothing; HR sees everyone', async () => {
      const rows = async (who: string) => (await (await env.as(who)).get('/api/attendance/team/day').query({ date: monday })).body;
      const mani = await rows('mani');
      expect(mani.map((r: any) => `${r.fullName}:${r.status}`)).toEqual(['Priya Raman:present', 'Ravi Kumar:present']);
      expect(mani.find((r: any) => r.fullName === 'Ravi Kumar')).toMatchObject({ late: true, flags: ['outside_geofence'] });
      expect(await rows('ravi')).toEqual([]);
      const hr = await rows('hema');
      expect(hr).toHaveLength(9);
      expect(hr.find((r: any) => r.fullName === 'Meena Sundaram').status).toBe('absent');
    });

    it('summarises a month per person', async () => {
      const summary = (await (await env.as('mani')).get('/api/attendance/team/summary').query({ month: monday.slice(0, 7) })).body;
      const priya = summary.find((r: any) => r.fullName === 'Priya Raman');
      expect(priya.summary).toMatchObject({ present: 1 });
      expect(summary.find((r: any) => r.fullName === 'Ravi Kumar').summary.late).toBe(1);
    });

    it('shows one person\'s month to their managers and HR, not to peers', async () => {
      const url = `/api/attendance/employees/${env.ids.priya}`;
      for (const who of ['priya', 'mani', 'hari', 'hema']) expect((await (await env.as(who)).get(url).query({ month: monday.slice(0, 7) })).status).toBe(200);
      for (const who of ['ravi', 'arun']) expect((await (await env.as(who)).get(url)).status).toBe(403);
    });

    it('lets a manager review the exact punches and locations behind a flag', async () => {
      const trail = (await (await env.as('mani')).get('/api/attendance/trail').query({ employeeId: env.ids.ravi, date: monday })).body;
      expect(trail[0]).toMatchObject({ type: 'check_in', withinGeofence: false, distanceM: expect.any(Number), flags: ['outside_geofence'] });
      expect(trail[0].distanceM).toBeGreaterThan(1500);
      expect(trail[0].latitude).toBeCloseTo(TWO_KM_AWAY.latitude, 6);
      expect((await (await env.as('priya')).get('/api/attendance/trail').query({ employeeId: env.ids.ravi, date: monday })).status).toBe(403);
      expect((await (await env.as('priya')).get('/api/attendance/trail').query({ date: monday })).body).toHaveLength(2); // default: yourself
    });

    it('exports the register as CSV for HR only, safe to open in a spreadsheet', async () => {
      await env.db.query(`update employees set full_name = '=HYPERLINK("http://evil")' where id = $1`, [env.ids.priya]);
      const month = monday.slice(0, 7);
      expect((await (await env.as('mani')).get('/api/admin/attendance/export').query({ month })).status).toBe(403);

      const res = await (await env.as('hema')).get('/api/admin/attendance/export').query({ month }).buffer(true).parse((r, cb) => {
        let data = ''; r.setEncoding('utf8'); r.on('data', (c: string) => (data += c)); r.on('end', () => cb(null, data));
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain(`attendance-${month}.csv`);
      const lines = (res.body as string).trim().split('\r\n');
      expect(lines[0]).toBe('Employee code,Name,Department,Date,Status,First in,Last out,Worked (min),Late,Flags');
      const ravi = lines.find((l) => l.startsWith('E005') && l.includes(monday))!;
      expect(ravi).toBe(`E005,Ravi Kumar,Operations,${monday},present,09:50,18:30,520,Yes,outside_geofence`);
      expect(lines.find((l) => l.startsWith('E004'))).toContain(`"'=HYPERLINK(""http://evil"")"`);
    });

    it('the nightly refresh fills the register for everyone, and can be re-run', async () => {
      const first = await att.runNightly();
      expect(first).toMatchObject({ employees: 9, failed: 0, to: todayIst() });
      const count = async () => (await env.db.one('select count(*)::int as n from attendance_days'))!.n as number;
      const n = await count();
      expect(n).toBeGreaterThan(9 * 4);
      expect((await storedDay(env.ids.md, addDays(todayIst(), -1))) === null).toBe(false);
      await att.runNightly();
      expect(await count()).toBe(n);
    });

    it('HR can rebuild the register for a range, within limits', async () => {
      const hr = await env.as('hema');
      const ok = await hr.post('/api/admin/attendance/refresh').send({ from: monday, to: tuesday });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ employees: 9, from: monday, to: tuesday, failed: 0 });
      expect((await hr.post('/api/admin/attendance/refresh').send({ from: '2025-01-01', to: '2026-01-01' })).body.code).toBe('RANGE_TOO_LONG');
      expect((await (await env.as('mani')).post('/api/admin/attendance/refresh').send({ from: monday, to: tuesday })).status).toBe(403);
    });
  });

  describe('office locations (geofences)', () => {
    it('lists active locations to everyone, and lets HR add, change and retire them', async () => {
      const priya = await env.as('priya');
      expect((await priya.get('/api/attendance/geofences')).body).toHaveLength(1);

      const hr = await env.as('hema');
      const created = await hr.post('/api/admin/geofences').send({ name: 'Coimbatore office', latitude: 11.0168, longitude: 76.9558, radiusM: 120 });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ kind: 'office', active: true, radiusM: 120 });
      expect((await priya.get('/api/attendance/geofences')).body).toHaveLength(2);

      const patched = await hr.patch(`/api/admin/geofences/${created.body.id}`).send({ radiusM: 200, active: false });
      expect(patched.body).toMatchObject({ radiusM: 200, active: false });
      expect((await priya.get('/api/attendance/geofences')).body).toHaveLength(1);
      expect((await hr.get('/api/admin/geofences')).body).toHaveLength(2);
      expect(await env.db.rows(`select 1 from audit_log where action like 'geofence.%'`)).toHaveLength(2);
    });

    it('a retired location no longer counts for new punches', async () => {
      await consentAll();
      await (await env.as('hema')).patch(`/api/admin/geofences/${env.ids.office}`).send({ active: false });
      const res = await punch(await env.as('priya'), 'check-in');
      expect(res.body.events[0].flags).toEqual(['no_geofence']);
    });

    it('validates input and is HR-only', async () => {
      const hr = await env.as('hema');
      const bad = { name: 'x', latitude: 11, longitude: 76, radiusM: 5 };
      expect((await hr.post('/api/admin/geofences').send(bad)).body.code).toBe('VALIDATION');
      expect((await hr.post('/api/admin/geofences').send({ ...bad, radiusM: 100, latitude: 100 })).body.code).toBe('VALIDATION');
      expect((await hr.patch('/api/admin/geofences/11111111-1111-4111-8111-111111111111').send({ radiusM: 100 })).status).toBe(404);
      const priya = await env.as('priya');
      expect((await priya.post('/api/admin/geofences').send({ ...bad, radiusM: 100 })).status).toBe(403);
      expect((await priya.get('/api/admin/geofences')).status).toBe(403);
    });
  });
  describe('go-live date', () => {
    const setStart = async (value: string | null) => (await env.as('hema')).put('/api/admin/settings').send({ attendance_start_date: value });

    it('shows nothing, rather than "absent", for days before attendance is tracked', async () => {
      const priya = await env.as('priya');
      expect((await dayOf(priya, monday)).status).toBe('absent'); // no go-live date yet: a past working day with no punch
      expect((await setStart(tuesday)).status).toBe(200);
      expect((await dayOf(priya, monday)).status).toBeNull();
      expect((await dayOf(priya, tuesday)).status).toBe('absent');
      const summary = (await priya.get('/api/attendance/me').query({ month: monday.slice(0, 7) })).body.summary;
      expect(summary.absent).toBeGreaterThanOrEqual(1);

      expect((await setStart(null)).status).toBe(200);
      expect((await dayOf(priya, monday)).status).toBe('absent');
    });

    it('keeps earlier days out of the monthly export and the team views', async () => {
      await setStart(tuesday);
      const hr = await env.as('hema');
      const csv = (await hr.get('/api/admin/attendance/export').query({ month: monday.slice(0, 7) })).text;
      expect(csv).not.toContain(`,${monday},`);
      expect(csv).toContain(`,${tuesday},`);
      const team = (await (await env.as('mani')).get('/api/attendance/team/day').query({ date: monday })).body;
      expect(team.every((r: any) => r.status === null)).toBe(true);
    });

    it('does not accept a correction for a day that is not tracked', async () => {
      await setStart(tuesday);
      const res = await (await env.as('priya')).post('/api/attendance/regularisations').send({ workDate: monday, checkInTime: '09:30', checkOutTime: '18:00', reason: 'Was in the office' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BEFORE_ATTENDANCE_START');
    });

    it('is set by HR only, and must be a real date', async () => {
      expect((await (await env.as('priya')).put('/api/admin/settings').send({ attendance_start_date: tuesday })).status).toBe(403);
      expect((await setStart('2026-02-30')).body.code).toBe('VALIDATION');
      expect((await setStart('soon')).body.code).toBe('VALIDATION');
    });
  });
});
