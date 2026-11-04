import { AttendanceService } from '../src/attendance/attendance.service';
import { AuthUser } from '../src/common/auth.types';
import { istInstant } from '../src/common/dates';
import { pastMonday } from './dates';
import { TestEnv, createTestEnv } from './helpers';

const OFFICE = { latitude: 13.0827, longitude: 80.2707 };
const FAR = { latitude: 13.2627, longitude: 80.2707 };

describe('breaks and random location checks', () => {
  let env: TestEnv;
  const day = pastMonday();
  let me: AuthUser;
  const at = (hhmm: string) => istInstant(day, hhmm);
  const svc = () => env.app.get(AttendanceService);
  const punch = (kind: 'check_in' | 'check_out', hhmm: string, loc = OFFICE) => svc().punch(me, kind, { ...loc, accuracyM: 10, source: 'web' }, at(hhmm));
  const dayRow = async () => (await env.db.one('select * from attendance_days where employee_id = $1 and work_date = $2', [env.ids.priya, day]))!;
  const always = () => 0;
  const never = () => 0.999;

  beforeAll(async () => { env = await createTestEnv(); });
  beforeEach(async () => {
    await env.reset();
    await env.db.query('delete from holidays');
    await env.db.query('delete from geofences');
    const office = (await env.db.one(`insert into geofences (name, latitude, longitude, radius_m) values ('Head office', $1, $2, 150) returning id`, [OFFICE.latitude, OFFICE.longitude]))!.id;
    await env.db.query('update employees set work_location_id = $2, location_consent_at = now(), photo_consent_at = now() where id = $1', [env.ids.priya, office]);
    const r = (await env.db.one('select id, emp_code, full_name, official_email, department_id, reporting_manager_id from employees where id = $1', [env.ids.priya]))!;
    me = { id: r.id, empCode: r.emp_code, fullName: r.full_name, email: r.official_email, roles: [], departmentId: r.department_id, reportingManagerId: r.reporting_manager_id };
  });
  afterAll(() => env.close());

  describe('breaks', () => {
    it('can only be taken while checked in, and one at a time', async () => {
      await expect(svc().startBreak(me, { kind: 'lunch' }, at('13:00'))).rejects.toMatchObject({ response: { code: 'NOT_CHECKED_IN' } });
      await punch('check_in', '09:30');
      const s = await svc().startBreak(me, { kind: 'lunch' }, at('13:00'));
      expect(s.onBreak).toMatchObject({ kind: 'lunch' });
      await expect(svc().startBreak(me, { kind: 'other' }, at('13:05'))).rejects.toMatchObject({ response: { code: 'ALREADY_ON_BREAK' } });
      const done = await svc().endBreak(me, at('13:25'));
      expect(done.onBreak).toBeNull();
      expect(done).toMatchObject({ usedMinutes: 25 });
      await expect(svc().endBreak(me, at('13:26'))).rejects.toMatchObject({ response: { code: 'NOT_ON_BREAK' } });
    });

    it('counts as working time, however long and whenever it is taken', async () => {
      await punch('check_in', '09:30');
      await svc().startBreak(me, { kind: 'lunch' }, at('14:30'));
      await svc().endBreak(me, at('15:20'));
      await punch('check_out', '17:30');
      const d = await dayRow();
      expect(d.worked_minutes).toBe(480);
      expect(d.flags).toEqual([]);
    });

    it('is closed by checking out', async () => {
      await punch('check_in', '09:30');
      await svc().startBreak(me, { kind: 'other', note: 'Bank' }, at('15:00'));
      await punch('check_out', '15:20');
      const open = await env.db.one('select 1 from work_breaks where ended_at is null');
      expect(open).toBeNull();
    });
  });

  describe('random location checks', () => {
    const poll = (hhmm: string, random = always) => svc().presenceCheck(me, at(hhmm), random);

    it('does not ask anyone who is not checked in', async () => {
      expect(await poll('11:00')).toBeNull();
    });

    it('does not ask straight after checking in, but can later; chance decides when', async () => {
      await punch('check_in', '09:30');
      expect(await poll('10:00')).toBeNull(); // too soon after checking in
      expect(await poll('11:40', never)).toBeNull(); // luck says not yet
      const c = await poll('11:40', always);
      expect(c).toMatchObject({ id: expect.any(String) });
      // the same check keeps being offered until it is answered
      expect(await poll('11:45', never)).toMatchObject({ id: c!.id });
    });

    it('is not sent to someone on a break, but is sent again once they are back at work', async () => {
      await punch('check_in', '09:30');
      await svc().startBreak(me, { kind: 'lunch' }, at('11:50'));
      expect(await poll('12:00')).toBeNull();
      await svc().endBreak(me, at('12:10'));
      expect(await poll('12:20')).not.toBeNull();
    });

    it('is also sent on approved on-duty work, where it only asks for a confirmation and never counts as outside', async () => {
      await env.db.query(`insert into od_requests (employee_id, kind, from_date, to_date, location, purpose, status) values ($1,'od',$2,$2,'Somewhere','Meeting','approved')`, [env.ids.priya, day]);
      await punch('check_in', '09:30', FAR);
      const c = await poll('11:40');
      expect(c).not.toBeNull();
      const res = await svc().answerPresence(me, c!.id, { ...FAR, accuracyM: 20 }, at('11:42'));
      expect(res.status).toBe('ok');
    });

    it('stops at the number of checks allowed in a day and keeps a gap between them', async () => {
      await punch('check_in', '09:30');
      const first = await poll('11:40');
      await svc().answerPresence(me, first!.id, OFFICE, at('11:42'));
      expect(await poll('12:30')).toBeNull(); // under 2 hours since the last
      const second = await poll('13:50');
      expect(second).not.toBeNull();
      await svc().answerPresence(me, second!.id, OFFICE, at('13:52'));
      expect(await poll('16:30')).toBeNull(); // two a day is the limit
    });

    it('can be switched off', async () => {
      await punch('check_in', '09:30');
      await env.db.query(`insert into org_settings (key, value) values ('presence_checks_per_day', '0'::jsonb) on conflict (key) do update set value = excluded.value`);
      (env.app.get(require('../src/common/settings.service').SettingsService) as any).invalidate();
      expect(await poll('12:00')).toBeNull();
    });

    it('is fine when answered from the office', async () => {
      await punch('check_in', '09:30');
      const c = await poll('11:40');
      const res = await svc().answerPresence(me, c!.id, { ...OFFICE, accuracyM: 20 }, at('11:43'));
      expect(res).toMatchObject({ status: 'ok' });
      const d = await dayRow();
      expect(await svc().presenceReport(day)).toEqual([]);
    });

    it('is flagged when answered from elsewhere', async () => {
      await punch('check_in', '09:30');
      const c = await poll('11:40');
      const res = await svc().answerPresence(me, c!.id, { ...FAR, accuracyM: 20 }, at('11:43'));
      expect(res.status).toBe('outside');
      // Only HR sees this; the day itself carries no mark for the manager.
      expect((await dayRow()).flags).toEqual([]);
      expect(await svc().presenceReport(day)).toMatchObject([{ employeeName: expect.any(String), status: 'outside', secondAsk: false }]);
    });

    it('does not hold a weak GPS fix against the person: they are asked to try again', async () => {
      await punch('check_in', '09:30');
      const c = await poll('11:40');
      await expect(svc().answerPresence(me, c!.id, { ...FAR, accuracyM: 400 }, at('11:43'))).rejects.toMatchObject({ response: { code: 'GPS_TOO_INACCURATE' } });
      const still = await poll('11:44', never);
      expect(still).toMatchObject({ id: c!.id });
    });

    it('is marked missed when nobody answers in time, shown to HR only, and asked once more 15 minutes later', async () => {
      await punch('check_in', '09:30');
      const c = await poll('11:40');
      expect(await poll('11:55', never)).toBeNull();
      const row = await env.db.one('select status from presence_checks where id = $1', [c!.id]);
      expect(row!.status).toBe('missed');
      expect((await dayRow()).flags).toEqual([]);
      expect(await svc().presenceReport(day)).toMatchObject([{ status: 'missed', secondAsk: false }]);
      await expect(svc().answerPresence(me, c!.id, OFFICE, at('11:56'))).rejects.toMatchObject({ response: { code: 'ALREADY_ANSWERED' } });

      // the second ask comes 15 minutes after the first ran out (11:50), whatever the luck
      expect(await poll('12:00', never)).toBeNull();
      const again = await poll('12:06', never);
      expect(again).toMatchObject({ id: expect.any(String) });
      expect(again!.id).not.toBe(c!.id);
      await svc().answerPresence(me, again!.id, OFFICE, at('12:08'));
      // answered, so nothing more, and the retry did not use up a daily check
      expect(await poll('12:30', never)).toBeNull();
      const n = await env.db.one(`select count(*)::int as n from presence_checks where retry_of is null`);
      expect(n!.n).toBe(1);
    });

    it('asks only once more when the second is missed too', async () => {
      await punch('check_in', '09:30');
      await poll('11:40');
      await poll('11:55', never);
      const again = await poll('12:06', never);
      expect(await poll('12:20', never)).toBeNull();
      const rep = await svc().presenceReport(day);
      expect(rep).toHaveLength(2);
      expect(rep.map((r) => r.secondAsk)).toEqual([false, true]);
      void again;
    });

    it('cannot be answered once its time has run out', async () => {
      await punch('check_in', '09:30');
      const c = await poll('11:40');
      await expect(svc().answerPresence(me, c!.id, OFFICE, at('11:52'))).rejects.toMatchObject({ response: { code: 'EXPIRED' } });
    });

    it('shows the report to HR only', async () => {
      expect((await (await env.as('priya')).get(`/api/attendance/presence/report?date=${day}`)).status).toBe(403);
      expect((await (await env.as('hema')).get(`/api/attendance/presence/report?date=${day}`)).status).toBe(200);
    });

    it('is served over the API for the signed-in person only', async () => {
      const priya = await env.as('priya');
      const res = await priya.get('/api/attendance/presence');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ check: null });
    });
  });
});
