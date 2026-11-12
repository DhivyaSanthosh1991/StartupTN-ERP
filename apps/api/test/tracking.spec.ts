import { AttendanceService } from '../src/attendance/attendance.service';
import { AuthUser } from '../src/common/auth.types';
import { istInstant } from '../src/common/dates';
import { SettingsService } from '../src/common/settings.service';
import { pastMonday } from './dates';
import { TestEnv, createTestEnv } from './helpers';

const OFFICE = { latitude: 13.0827, longitude: 80.2707 };
const FAR = { latitude: 13.2627, longitude: 80.2707 }; // about 20 km north

describe('location while checked in, and "left the office" alerts', () => {
  let env: TestEnv;
  const day = pastMonday();
  let me: AuthUser;
  const at = (hhmm: string) => istInstant(day, hhmm);
  const svc = () => env.app.get(AttendanceService);
  const punch = (kind: 'check_in' | 'check_out', hhmm: string, loc = OFFICE) => svc().punch(me, kind, { ...loc, accuracyM: 10, source: 'web' }, at(hhmm));
  const ping = (hhmm: string, loc = OFFICE, accuracyM = 20) => svc().trackingPing(me, { ...loc, accuracyM }, at(hhmm)) as Promise<any>;
  const pings = async () => (await env.db.rows('select within_fence from location_pings where employee_id = $1 order by recorded_at', [env.ids.priya]));
  const alerts = () => env.db.rows('select * from away_alerts where employee_id = $1 order by raised_at', [env.ids.priya]);
  const setSetting = async (key: string, value: unknown) => {
    await env.db.query(`insert into org_settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)]);
    env.app.get(SettingsService).invalidate();
  };

  beforeAll(async () => { env = await createTestEnv(); });
  beforeEach(async () => {
    await env.reset();
    env.app.get(SettingsService).invalidate();
    await env.db.query('delete from holidays');
    await env.db.query('delete from geofences');
    const office = (await env.db.one(`insert into geofences (name, latitude, longitude, radius_m) values ('Head office', $1, $2, 150) returning id`, [OFFICE.latitude, OFFICE.longitude]))!.id;
    await env.db.query('update employees set work_location_id = $2, location_consent_at = now(), photo_consent_at = now() where id = $1', [env.ids.priya, office]);
    const r = (await env.db.one('select id, emp_code, full_name, official_email, department_id, reporting_manager_id from employees where id = $1', [env.ids.priya]))!;
    me = { id: r.id, empCode: r.emp_code, fullName: r.full_name, email: r.official_email, roles: [], departmentId: r.department_id, reportingManagerId: r.reporting_manager_id };
  });
  afterAll(() => env.close());

  describe('when readings are taken', () => {
    it('only between check-in and check-out', async () => {
      expect(await ping('09:00')).toMatchObject({ recorded: false, active: false });
      await punch('check_in', '09:30');
      expect(await svc().trackingState(me, at('09:31'))).toMatchObject({ active: true, intervalMinutes: 10 });
      expect(await ping('09:40')).toMatchObject({ recorded: true });
      await punch('check_out', '17:30');
      expect(await svc().trackingState(me, at('17:31'))).toMatchObject({ active: false });
      expect(await ping('17:40')).toMatchObject({ recorded: false });
      expect(await pings()).toHaveLength(1);
    });

    it('not during a break, and again once they are back at work', async () => {
      await punch('check_in', '09:30');
      await svc().startBreak(me, { kind: 'lunch' }, at('13:00'));
      expect(await svc().trackingState(me, at('13:05'))).toMatchObject({ active: false });
      expect(await ping('13:10')).toMatchObject({ recorded: false });
      await svc().endBreak(me, at('13:30'));
      expect(await ping('13:40')).toMatchObject({ recorded: true });
    });

    it('ignores readings that come too close together or are too rough to mean anything', async () => {
      await punch('check_in', '09:30');
      await ping('09:40');
      await svc().trackingPing(me, { ...OFFICE, accuracyM: 20 }, new Date(at('09:40').getTime() + 30_000));
      await ping('09:50', OFFICE, 900);
      expect(await pings()).toHaveLength(1);
    });

    it('can be switched off', async () => {
      await punch('check_in', '09:30');
      await setSetting('tracking_enabled', false);
      expect(await svc().trackingState(me, at('09:40'))).toMatchObject({ enabled: false, active: false });
      expect(await ping('09:40')).toMatchObject({ recorded: false });
    });

    it('is not asked of someone on the biometric machine or who has not agreed to share location', async () => {
      await punch('check_in', '09:30');
      await env.db.query('update employees set location_consent_at = null where id = $1', [env.ids.priya]);
      expect(await svc().trackingState(me, at('09:40'))).toMatchObject({ active: false });
    });
  });

  describe('leaving the office area', () => {
    beforeEach(async () => { await punch('check_in', '09:30'); });

    it('says nothing while the person is inside, or has been away only briefly', async () => {
      await ping('10:00');
      await ping('10:10', FAR);
      expect(await alerts()).toEqual([]);
      await ping('10:15', FAR); // 5 minutes
      expect(await alerts()).toEqual([]);
    });

    it('raises an alert once they have been away longer than the grace period, dated from when they left', async () => {
      await ping('10:00');
      await ping('10:10', FAR);
      const res = await ping('10:22', FAR);
      const a = await alerts();
      expect(a).toHaveLength(1);
      expect(a[0].left_at.getTime()).toBe(at('10:10').getTime());
      expect(a[0].returned_at).toBeNull();
      expect(res.away).toMatchObject({ explained: false });
      // more readings from outside do not make more alerts
      await ping('10:35', FAR);
      expect(await alerts()).toHaveLength(1);
    });

    it('closes the alert when they are back inside', async () => {
      await ping('10:10', FAR);
      await ping('10:25', FAR);
      const res = await ping('10:40');
      expect((await alerts())[0].returned_at.getTime()).toBe(at('10:40').getTime());
      expect(res.away).toBeNull();
      // a second trip makes a second alert
      await ping('11:00', FAR);
      await ping('11:15', FAR);
      expect(await alerts()).toHaveLength(2);
    });

    it('does not count a rough reading as being outside', async () => {
      await ping('10:10', FAR, 250);
      await ping('10:25', FAR, 250);
      expect(await alerts()).toEqual([]);
    });

    it('does not raise anything for someone on a break', async () => {
      await svc().startBreak(me, { kind: 'lunch' }, at('10:00'));
      await ping('10:10', FAR);
      await ping('10:30', FAR);
      expect(await alerts()).toEqual([]);
    });

    it('does not raise anything on approved on-duty work or within an approved permission', async () => {
      await env.db.query(
        `insert into od_requests (employee_id, kind, from_date, to_date, from_time, to_time, purpose, status)
         values ($1,'permission',$2,$2,'10:00','12:00','Bank','approved')`, [env.ids.priya, day]);
      await ping('10:10', FAR);
      await ping('10:30', FAR);
      expect(await alerts()).toEqual([]);
      await env.db.query('delete from od_requests');
      await env.db.query(`insert into od_requests (employee_id, kind, from_date, to_date, location, purpose, status) values ($1,'od',$2,$2,'Venue','Meeting','approved')`, [env.ids.priya, day]);
      await ping('14:10', FAR);
      await ping('14:30', FAR);
      expect(await alerts()).toEqual([]);
    });

    it('uses the grace period from settings', async () => {
      await setSetting('tracking_away_grace_minutes', 30);
      await ping('10:10', FAR);
      await ping('10:25', FAR);
      expect(await alerts()).toEqual([]);
      await ping('10:45', FAR);
      expect(await alerts()).toHaveLength(1);
    });
  });

  describe('the explanation', () => {
    beforeEach(async () => {
      await punch('check_in', '09:30');
      await ping('10:10', FAR);
      await ping('10:25', FAR);
    });

    it('is recorded against the alert for HR to read', async () => {
      const [a] = await alerts();
      const st = await svc().explainAway(me, a.id, { kind: 'official', note: 'Collecting a parcel from the courier' }, at('10:27'));
      expect(st.away).toMatchObject({ explained: true });
      const row = (await alerts())[0];
      expect(row).toMatchObject({ reason_kind: 'official', reason_note: 'Collecting a parcel from the courier' });
    });

    it('"break" also puts them in break mode', async () => {
      const [a] = await alerts();
      await svc().explainAway(me, a.id, { kind: 'break' }, at('10:27'));
      expect(await svc().trackingState(me, at('10:28'))).toMatchObject({ active: false });
      expect((await svc().startBreak(me, { kind: 'lunch' }, at('10:29')).catch((e) => e)).response?.code).toBe('ALREADY_ON_BREAK');
    });

    it('belongs to the person it is about, and official or other needs a few words', async () => {
      const [a] = await alerts();
      const mani = await env.as('mani');
      expect((await mani.post(`/api/attendance/track/alerts/${a.id}`).send({ kind: 'personal' })).status).toBe(404);
      const priya = await env.as('priya');
      expect((await priya.post(`/api/attendance/track/alerts/${a.id}`).send({ kind: 'official' })).status).toBe(400);
      expect((await priya.post(`/api/attendance/track/alerts/${a.id}`).send({ kind: 'personal' })).status).toBe(200);
    });
  });

  describe('what HR sees', () => {
    it('lists the alerts of a day and who is checked in with their latest reading, HR only', async () => {
      await punch('check_in', '09:30');
      await ping('10:10', FAR);
      await ping('10:25', FAR);
      const hr = await env.as('hema');
      const list = await hr.get(`/api/admin/tracking/alerts?date=${day}`);
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject([{ employeeName: expect.any(String), reasonKind: null, returnedAt: null }]);
      const live = await svc().liveLocations(at('10:30'));
      expect(live.find((r) => r.employeeId === env.ids.priya)).toMatchObject({ place: 'outside', minutesAgo: 5 });
      expect((await (await env.as('priya')).get('/api/admin/tracking/alerts')).status).toBe(403);
      expect((await (await env.as('priya')).get('/api/admin/tracking/live')).status).toBe(403);
    });

    it('leaves out people who have checked out', async () => {
      await punch('check_in', '09:30');
      await ping('10:10');
      await punch('check_out', '17:30');
      expect((await svc().liveLocations(at('17:40'))).find((r) => r.employeeId === env.ids.priya)).toBeUndefined();
    });
  });

  describe('keeping it tidy', () => {
    it('deletes readings after the retention period but keeps the alerts', async () => {
      await punch('check_in', '09:30');
      await ping('10:10', FAR);
      await ping('10:25', FAR);
      await svc().purgeExpiredSelfies(new Date(at('10:30').getTime() + 40 * 86_400_000));
      expect(await pings()).toEqual([]);
      expect(await alerts()).toHaveLength(1);
    });
  });
});
