import { AttendanceService } from '../src/attendance/attendance.service';
import { AuthUser } from '../src/common/auth.types';
import { istInstant } from '../src/common/dates';
import { PushService } from '../src/common/push.service';
import { pastMonday } from './dates';
import { TestEnv, createTestEnv, testConfig } from './helpers';

const OFFICE = { latitude: 13.0827, longitude: 80.2707 };
const FAR = { latitude: 13.2627, longitude: 80.2707 };

describe('notifications that reach a closed app', () => {
  let env: TestEnv;
  const day = pastMonday();
  let me: AuthUser;
  const at = (hhmm: string) => istInstant(day, hhmm);
  const svc = () => env.app.get(AttendanceService);
  const push = () => env.app.get(PushService);
  const punch = (kind: 'check_in' | 'check_out', hhmm: string) => svc().punch(me, kind, { ...OFFICE, accuracyM: 10, source: 'mobile' }, at(hhmm));
  const addPhone = (employeeId = env.ids.priya, token = 'ExponentPushToken[aaaaaaaaaaaa]') =>
    env.db.query(`insert into devices (employee_id, push_token, platform) values ($1, $2, 'android')`, [employeeId, token]);

  beforeAll(async () => { env = await createTestEnv(); });
  beforeEach(async () => {
    await env.reset();
    await env.db.query('delete from holidays');
    await env.db.query('delete from geofences');
    const office = (await env.db.one(`insert into geofences (name, latitude, longitude, radius_m) values ('Head office', $1, $2, 150) returning id`, [OFFICE.latitude, OFFICE.longitude]))!.id;
    await env.db.query('update employees set work_location_id = $2, location_consent_at = now(), photo_consent_at = now() where id = $1', [env.ids.priya, office]);
    const r = (await env.db.one('select id, emp_code, full_name, official_email, department_id, reporting_manager_id from employees where id = $1', [env.ids.priya]))!;
    me = { id: r.id, empCode: r.emp_code, fullName: r.full_name, email: r.official_email, roles: [], departmentId: r.department_id, reportingManagerId: r.reporting_manager_id };
    push().sent.length = 0;
  });
  afterAll(() => env.close());

  describe('random presence checks', () => {
    it('start for someone checked in who has the app, and are pushed once', async () => {
      await addPhone();
      await punch('check_in', '09:30');
      const first = await svc().pushPresenceChecks(at('12:00'), () => 0);
      expect(first).toMatchObject({ checkedIn: 1, pushed: 1 });
      expect(push().sent).toHaveLength(1);
      expect(push().sent[0]).toMatchObject({ employeeId: env.ids.priya, data: { type: 'presence' } });
      // the same waiting check is not pushed again a minute later
      expect((await svc().pushPresenceChecks(at('12:01'), () => 0)).pushed).toBe(0);
      expect(push().sent).toHaveLength(1);
    });

    it('leave out people with no app, people not checked in, and people who checked out', async () => {
      await punch('check_in', '09:30');
      expect((await svc().pushPresenceChecks(at('12:00'), () => 0)).pushed).toBe(0);
      await addPhone();
      await punch('check_out', '11:00');
      expect((await svc().pushPresenceChecks(at('12:00'), () => 0)).pushed).toBe(0);
      expect(push().sent).toHaveLength(0);
    });

    it('follow the usual random chance and the gap after check-in', async () => {
      await addPhone();
      await punch('check_in', '09:30');
      expect((await svc().pushPresenceChecks(at('10:00'), () => 0)).pushed).toBe(0); // too soon after check-in
      expect((await svc().pushPresenceChecks(at('12:00'), () => 0.999)).pushed).toBe(0); // not this time
      expect(await env.db.rows('select 1 from presence_checks')).toHaveLength(0);
    });

    it('can be started by the scheduler endpoint, which needs the jobs token', async () => {
      expect((await env.anon().post('/api/jobs/presence-checks')).status).toBe(401);
      const ok = await env.anon().post('/api/jobs/presence-checks').set('x-jobs-token', (testConfig as any).jobsToken);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ pushed: 0 });
    });
  });

  describe('away alerts', () => {
    it('are pushed when raised, and only once', async () => {
      await addPhone();
      await punch('check_in', '09:30');
      await svc().trackingPing(me, { ...OFFICE, accuracyM: 20 }, at('10:00'));
      await svc().trackingPing(me, { ...FAR, accuracyM: 20 }, at('10:10'));
      expect(push().sent).toHaveLength(0);
      await svc().trackingPing(me, { ...FAR, accuracyM: 20 }, at('10:22'));
      expect(push().sent).toHaveLength(1);
      expect(push().sent[0]).toMatchObject({ data: { type: 'away' } });
      await svc().trackingPing(me, { ...FAR, accuracyM: 20 }, at('10:35'));
      expect(push().sent).toHaveLength(1);
    });
  });

  it('does nothing, without error, for a person with no phone registered', async () => {
    expect(await push().toEmployee(env.ids.priya, { title: 'x', body: 'y' })).toBe(0);
  });
});
