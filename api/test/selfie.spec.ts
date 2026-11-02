import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { AuthUser } from '../src/common/auth.types';
import { addDays, istInstant, todayIst } from '../src/common/dates';
import { AttendanceService } from '../src/attendance/attendance.service';
import { decodeSelfie, MAX_SELFIE_BYTES, MIN_SELFIE_BYTES } from '../src/attendance/selfie';
import { DemoIds } from '../src/db/seed';
import { TestEnv, createTestEnv, testConfig } from './helpers';

const OFFICE = { latitude: 13.0827, longitude: 80.2707 };

/** Not a real photograph, but the right shape: starts like a JPEG, ends like one, and is big enough. */
const jpeg = (size = 5_000, fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, fill), Buffer.from([0xff, 0xd9])]);
const b64 = (b: Buffer) => b.toString('base64');

describe('selfie check-in', () => {
  let env: TestEnv;
  let att: AttendanceService;

  const user = async (key: keyof DemoIds): Promise<AuthUser> => {
    const r = (await env.db.one(
      'select id, emp_code, full_name, official_email, department_id, reporting_manager_id from employees where id = $1', [env.ids[key]]))!;
    return { id: r.id, empCode: r.emp_code, fullName: r.full_name, email: r.official_email, roles: [], departmentId: r.department_id, reportingManagerId: r.reporting_manager_id };
  };
  const setSettings = async (patch: Record<string, unknown>) => {
    const res = await (await env.as('hema')).put('/api/admin/settings').send(patch);
    expect(res.status).toBe(200);
  };
  const consentAll = () => env.db.query('update employees set location_consent_at = now(), photo_consent_at = now()');
  const punch = (agent: any, kind: 'check-in' | 'check-out', body: Record<string, unknown> = {}) =>
    agent.post(`/api/attendance/${kind}`).send({ ...OFFICE, accuracyM: 12, ...body });
  const storedFiles = (employeeKey: keyof DemoIds) => {
    const dir = join(testConfig.storageDir, 'selfies', env.ids[employeeKey]);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
  };

  beforeAll(async () => {
    env = await createTestEnv();
    att = env.app.get(AttendanceService);
  });
  beforeEach(async () => {
    await env.reset();
    await env.db.query('delete from holidays');
    await setSettings({ selfie_required: true });
  });
  afterAll(() => env.close());

  describe('what counts as a photo', () => {
    it('accepts a JPEG with or without the data-URL prefix', () => {
      const photo = jpeg();
      expect(decodeSelfie(b64(photo))?.equals(photo)).toBe(true);
      expect(decodeSelfie(`data:image/jpeg;base64,${b64(photo)}`)?.equals(photo)).toBe(true);
    });

    it.each([
      ['empty text', ''],
      ['text that is not base64', 'not a photo!!'],
      ['a PNG', b64(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(5000)]))],
      ['a JPEG cut off before its end', b64(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5000, 7)]))],
      ['a file that is far too small', b64(jpeg(10))],
      ['a file that is too large', b64(jpeg(MAX_SELFIE_BYTES))],
    ])('refuses %s', (_name, text) => {
      expect(decodeSelfie(text)).toBeNull();
    });

    it('has sensible size limits', () => {
      expect(MIN_SELFIE_BYTES).toBeLessThan(MAX_SELFIE_BYTES);
      expect(decodeSelfie(b64(jpeg(MAX_SELFIE_BYTES - 100)))).not.toBeNull();
    });
  });

  describe('the rules at check-in', () => {
    it('is required unless HR switches it off, and says so on the home data', async () => {
      const priya = await env.as('priya');
      const t = (await priya.get('/api/attendance/today')).body;
      expect(t.selfieRequired).toBe(true);
      expect(t.photoConsent).toBe(false);
    });

    it('asks for the photo notice to be accepted before a selfie punch', async () => {
      const priya = await env.as('priya');
      await priya.post('/api/me/location-consent');
      const refused = await punch(priya, 'check-in', { selfie: b64(jpeg()) });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('PHOTO_CONSENT_REQUIRED');

      const accepted = await priya.post('/api/me/photo-consent');
      expect(accepted.status).toBe(200);
      expect(accepted.body.photoConsentAt).toBeTruthy();
      expect((await priya.get('/api/attendance/today')).body.photoConsent).toBe(true);
      expect(await env.db.rows(`select 1 from audit_log where action = 'employee.photo_consent' and actor_id = $1`, [env.ids.priya])).toHaveLength(1);
    });

    it('refuses a punch with no selfie while selfies are required', async () => {
      await consentAll();
      const priya = await env.as('priya');
      const refused = await punch(priya, 'check-in');
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('SELFIE_REQUIRED');
      expect((await priya.get('/api/attendance/today')).body.events).toHaveLength(0);
    });

    it('refuses a photo that is not a usable JPEG, and records nothing', async () => {
      await consentAll();
      const priya = await env.as('priya');
      const refused = await punch(priya, 'check-in', { selfie: 'AAAA' });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('SELFIE_INVALID');
      expect((await priya.get('/api/attendance/today')).body.events).toHaveLength(0);
      expect(storedFiles('priya')).toHaveLength(0);
    });

    it('saves the photo with the punch and the location', async () => {
      await consentAll();
      const priya = await env.as('priya');
      const photo = jpeg(6_000, 9);
      const res = await punch(priya, 'check-in', { selfie: `data:image/jpeg;base64,${b64(photo)}` });
      expect(res.status).toBe(200);
      const ev = res.body.events[0];
      expect(ev).toMatchObject({ type: 'check_in', selfie: true, selfiePurged: false, latitude: OFFICE.latitude });
      expect(storedFiles('priya')).toHaveLength(1);

      const image = await priya.get(`/api/attendance/events/${ev.id}/selfie`).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(image.status).toBe(200);
      expect(image.headers['content-type']).toBe('image/jpeg');
      expect(image.headers['cache-control']).toContain('no-store');
      expect((image.body as Buffer).equals(photo)).toBe(true);
    });

    it('works without a photo when HR has switched selfies off', async () => {
      await setSettings({ selfie_required: false });
      await env.db.query('update employees set location_consent_at = now()');
      const priya = await env.as('priya');
      const res = await punch(priya, 'check-in');
      expect(res.status).toBe(200);
      expect(res.body.selfieRequired).toBe(false);
      expect(res.body.events[0].selfie).toBe(false);
      const none = await priya.get(`/api/attendance/events/${res.body.events[0].id}/selfie`);
      expect(none.status).toBe(404);
      expect(none.body.code).toBe('SELFIE_NOT_FOUND');
    });

    it('leaves no stored photo behind when the punch itself is refused', async () => {
      await consentAll();
      const priya = await env.as('priya');
      expect((await punch(priya, 'check-in', { selfie: b64(jpeg()) })).status).toBe(200);
      const again = await punch(priya, 'check-in', { selfie: b64(jpeg(5_000, 3)) });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_CHECKED_IN');
      expect(storedFiles('priya')).toHaveLength(1);
    });

    it('takes a photo at check-out too, so both punches have one', async () => {
      await consentAll();
      const priya = await env.as('priya');
      await punch(priya, 'check-in', { selfie: b64(jpeg()) });
      const out = await punch(priya, 'check-out', { selfie: b64(jpeg(5_000, 4)) });
      expect(out.body.events.map((e: any) => [e.type, e.selfie])).toEqual([['check_in', true], ['check_out', true]]);
      expect(storedFiles('priya')).toHaveLength(2);
    });

    it('refuses a request body far larger than any photo', async () => {
      await consentAll();
      const priya = await env.as('priya');
      const res = await punch(priya, 'check-in', { selfie: 'A'.repeat(700_000) });
      expect(res.status).toBe(413);
    });
  });

  describe('who may look at a photo', () => {
    let eventId: string;
    beforeEach(async () => {
      await consentAll();
      const res = await punch(await env.as('priya'), 'check-in', { selfie: b64(jpeg()) });
      eventId = res.body.events[0].id;
    });
    const view = async (who: string) => (await env.as(who)).get(`/api/attendance/events/${eventId}/selfie`);
    const lookAudit = () => env.db.rows(`select actor_id from audit_log where action = 'attendance.selfie_view'`);

    it('lets the person, their reporting manager and HR see it', async () => {
      expect((await view('priya')).status).toBe(200);
      expect((await view('mani')).status).toBe(200);
      expect((await view('hema')).status).toBe(200);
    });

    it('keeps it from colleagues outside the reporting line', async () => {
      const refused = await view('ravi');
      expect(refused.status).toBe(403);
      expect((await view('arun')).status).toBe(403);
    });

    it('requires a signed-in session', async () => {
      expect((await env.anon().get(`/api/attendance/events/${eventId}/selfie`)).status).toBe(401);
    });

    it('writes a record when someone else looks, once per viewer in a short time, and none for the owner', async () => {
      await view('priya');
      expect(await lookAudit()).toHaveLength(0);
      await view('mani');
      await view('mani');
      await view('hema');
      const looks = await lookAudit();
      expect(looks.map((l: any) => l.actor_id).sort()).toEqual([env.ids.manager, env.ids.hr].sort());
    });

    it('answers 404 for a punch that does not exist', async () => {
      const res = await (await env.as('hema')).get('/api/attendance/events/00000000-0000-4000-8000-000000000000/selfie');
      expect(res.status).toBe(404);
    });

    it('shows the photo flag, not the picture, in a day\'s trail', async () => {
      const trail = await (await env.as('mani')).get('/api/attendance/trail').query({ employeeId: env.ids.priya, date: todayIst() });
      expect(trail.status).toBe(200);
      expect(trail.body[0]).toMatchObject({ selfie: true, selfiePurged: false });
      expect(JSON.stringify(trail.body)).not.toContain('base64');
    });
  });

  describe('keeping photos only for the retention period', () => {
    it('accepts retention between 7 and 365 days only', async () => {
      const hr = await env.as('hema');
      expect((await hr.put('/api/admin/settings').send({ selfie_retention_days: 3 })).status).toBe(400);
      expect((await hr.put('/api/admin/settings').send({ selfie_retention_days: 400 })).status).toBe(400);
      const ok = await hr.put('/api/admin/settings').send({ selfie_retention_days: 30 });
      expect(ok.status).toBe(200);
      expect(ok.body.selfie_retention_days).toBe(30);
    });

    it('deletes old photos but keeps the punch, its time and its location', async () => {
      await consentAll();
      await setSettings({ selfie_retention_days: 30 });
      const priya = await user('priya');
      const oldDay = addDays(todayIst(), -40);
      const oldPunch = await att.punch(priya, 'check_in', { ...OFFICE, accuracyM: 10, source: 'web', selfie: b64(jpeg()) }, istInstant(oldDay, '09:10'));
      const newPunch = await punch(await env.as('priya'), 'check-in', { selfie: b64(jpeg(5_000, 5)) });
      expect(oldPunch.date).toBe(todayIst());
      expect(storedFiles('priya')).toHaveLength(2);

      const run = await env.anon().post('/api/jobs/selfie-cleanup').set('x-jobs-token', testConfig.jobsToken);
      expect(run.status).toBe(200);
      expect(run.body).toEqual({ removed: 1 });
      expect(storedFiles('priya')).toHaveLength(1);

      const rows = await env.db.rows('select event_at, latitude, selfie_key, selfie_purged_at, work_date::text as d from attendance_events order by event_at');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ selfie_key: null, latitude: OFFICE.latitude, d: oldDay });
      expect(rows[0].selfie_purged_at).toBeTruthy();
      expect(rows[1].selfie_key).toBeTruthy();

      const gone = await (await env.as('hema')).get(`/api/attendance/trail`).query({ employeeId: env.ids.priya, date: oldDay });
      expect(gone.body[0]).toMatchObject({ selfie: false, selfiePurged: true });
      const missing = await (await env.as('hema')).get(`/api/attendance/events/${gone.body[0].id}/selfie`);
      expect(missing.status).toBe(404);
      expect(missing.body.message).toContain('retention');

      expect((await (await env.as('priya')).get('/api/attendance/today')).body.events[0].id).toBe(newPunch.body.events[0].id);
      expect(await env.db.rows(`select after_data from audit_log where action = 'attendance.selfie_purge'`)).toHaveLength(1);
    });

    it('does nothing the second time', async () => {
      const first = await env.anon().post('/api/jobs/selfie-cleanup').set('x-jobs-token', testConfig.jobsToken);
      const second = await env.anon().post('/api/jobs/selfie-cleanup').set('x-jobs-token', testConfig.jobsToken);
      expect(first.body).toEqual({ removed: 0 });
      expect(second.body).toEqual({ removed: 0 });
      expect(await env.db.rows(`select 1 from audit_log where action = 'attendance.selfie_purge'`)).toHaveLength(0);
    });
  });
});
