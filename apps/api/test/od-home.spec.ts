import { AttendanceService } from '../src/attendance/attendance.service';
import { istInstant } from '../src/common/dates';
import { AuthUser } from '../src/common/auth.types';
import { estimateReturn } from '../src/od/od-home.service';
import { OdHomeService } from '../src/od/od-home.service';
import { OdService } from '../src/od/od.service';
import { pastMonday } from './dates';
import { TestEnv, createTestEnv } from './helpers';
import { decide } from './leave-helpers';

const OFFICE = { latitude: 13.0827, longitude: 80.2707 };
const SITE = { latitude: 13.2627, longitude: 80.2707 }; // about 20 km north of the office

describe('on duty: at the site, and the way home', () => {
  let env: TestEnv;
  const day = pastMonday();
  let dutyId: string;
  let me: AuthUser;

  const punch = (kind: 'check_in' | 'check_out', hhmm: string, loc = SITE) =>
    env.app.get(AttendanceService).punch(me, kind, { ...loc, accuracyM: 10, source: 'web' }, istInstant(day, hhmm));
  const status = (hhmm: string) => env.app.get(OdHomeService).today(me, istInstant(day, hhmm));

  beforeAll(async () => { env = await createTestEnv(); });
  beforeEach(async () => {
    await env.reset();
    await env.db.query('delete from holidays');
    // The standard chain for this request type (the test reset puts back only the original four).
    await env.db.query(`insert into approval_workflows (request_type, name) values ('od_home', 'Going home after duty')`);
    await env.db.query(`insert into approval_workflow_steps (workflow_id, step_order, approver_kind, sla_hours)
                        select id, 1, 'reporting_manager', 24 from approval_workflows where request_type = 'od_home'`);
    await env.db.query('delete from geofences');
    const office = (await env.db.one(`insert into geofences (name, latitude, longitude, radius_m) values ('Head office - Chennai', $1, $2, 150) returning id`, [OFFICE.latitude, OFFICE.longitude]))!.id;
    await env.db.query('update employees set work_location_id = $2, location_consent_at = now() where id = $1', [env.ids.priya, office]);
    dutyId = (await env.db.one(
      `insert into od_requests (employee_id, kind, from_date, to_date, location, purpose, status)
       values ($1,'od',$2,$2,'Startup summit, Ponneri','Summit','approved') returning id`, [env.ids.priya, day]))!.id;
    const r = (await env.db.one('select id, emp_code, full_name, official_email, department_id, reporting_manager_id from employees where id = $1', [env.ids.priya]))!;
    me = { id: r.id, empCode: r.emp_code, fullName: r.full_name, email: r.official_email, roles: [], departmentId: r.department_id, reportingManagerId: r.reporting_manager_id };
  });
  afterAll(() => env.close());

  it('needs the place of the duty when it is requested', async () => {
    const priya = await env.as('priya');
    const none = await priya.post('/api/od/requests').send({ kind: 'od', fromDate: day, purpose: 'Visit' });
    expect(none.status).toBe(400);
  });

  it('ties the punches of an on-duty day to the duty, so the approver sees the visit', async () => {
    await punch('check_in', '11:05');
    await punch('check_out', '15:40');
    const view = await env.app.get(OdService).getOne(dutyId);
    expect(view.siteVisits.map((v) => v.type)).toEqual(['check_in', 'check_out']);
    expect(view.siteVisits[0]).toMatchObject({ latitude: SITE.latitude, longitude: SITE.longitude });
  });

  it('knows nothing of a person with no duty today', async () => {
    await env.db.query(`update od_requests set status = 'cancelled'`);
    expect(await status('12:00')).toEqual({ onDuty: false });
  });

  it('follows the day: not started, at the site, finished', async () => {
    expect(await status('09:00')).toMatchObject({ onDuty: true, state: 'not_started', duty: { location: 'Startup summit, Ponneri' } });
    await punch('check_in', '11:05');
    expect(await status('12:00')).toMatchObject({ state: 'on_site', estimate: null });
    await punch('check_out', '15:40');
    expect(await status('15:41')).toMatchObject({ state: 'finished', officeName: 'Head office - Chennai' });
  });

  it('suggests going home when the office would be reached just before closing, not when there is plenty of time', async () => {
    await punch('check_in', '11:05');
    await punch('check_out', '16:40');
    const late = (await status('16:41')) as any;
    expect(late.estimate).toMatchObject({ suggested: true, officeEnd: '17:30' });
    expect(late.estimate.travelMinutes).toBeGreaterThan(50);

    const early = estimateReturn(20_000, 13 * 60, 17 * 60 + 30);
    expect(early.suggested).toBe(false);
    expect(estimateReturn(20_000, 16 * 60 + 40, 17 * 60 + 30).suggested).toBe(true);
  });

  it('cannot ask to go home before the work at the site is finished', async () => {
    const svc = env.app.get(OdHomeService);
    await expect(svc.apply(me, {}, istInstant(day, '09:00'))).rejects.toMatchObject({ response: { code: 'DUTY_NOT_FINISHED' } });
    await punch('check_in', '11:05');
    await expect(svc.apply(me, {}, istInstant(day, '12:00'))).rejects.toMatchObject({ response: { code: 'DUTY_NOT_FINISHED' } });
  });

  it('sends the request to the manager with the travel estimate, and records the decision', async () => {
    await punch('check_in', '11:05');
    await punch('check_out', '16:40');
    const svc = env.app.get(OdHomeService);
    const req = await svc.apply(me, { reason: 'Heavy traffic expected' }, istInstant(day, '16:41'));
    expect(req).toMatchObject({ status: 'pending', travelMinutes: expect.any(Number) });
    expect((await (await env.as('mani')).get('/api/approvals/inbox')).body[0]).toMatchObject({
      typeLabel: 'Going home after duty', summary: expect.stringContaining('Startup summit, Ponneri') });

    await expect(svc.apply(me, {}, istInstant(day, '16:42'))).rejects.toMatchObject({ response: { code: 'ALREADY_ASKED' } });
    const done = await decide(await env.as('mani'), req.approvalRequestId!, 'approve');
    expect(done.body.status).toBe('approved');
    expect((await env.db.one('select status from od_home_requests where id = $1', [req.id]))!.status).toBe('approved');
  });

  it('lets a rejected request be asked again, and a pending one be withdrawn', async () => {
    await punch('check_in', '11:05');
    await punch('check_out', '16:40');
    const svc = env.app.get(OdHomeService);
    const first = await svc.apply(me, {}, istInstant(day, '16:41'));
    await decide(await env.as('mani'), first.approvalRequestId!, 'reject', 'Please come to the office');
    expect((await env.db.one('select status from od_home_requests where id = $1', [first.id]))!.status).toBe('rejected');
    const second = await svc.apply(me, {}, istInstant(day, '16:50'));
    expect((await svc.cancel(me, second.id)).status).toBe('cancelled');
  });
});
