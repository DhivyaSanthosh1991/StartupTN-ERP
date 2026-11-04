import { AttendanceService } from '../src/attendance/attendance.service';
import { istInstant } from '../src/common/dates';
import { AuthUser } from '../src/common/auth.types';
import { OdHomeService } from '../src/od/od-home.service';
import { OdService } from '../src/od/od.service';
import { futureMonday, pastMonday } from './dates';
import { TestEnv, createTestEnv } from './helpers';
import { decide } from './leave-helpers';

const OFFICE = { latitude: 13.0827, longitude: 80.2707 };
const SITE = { latitude: 13.2627, longitude: 80.2707 };
const SECOND = { latitude: 13.0, longitude: 80.2 };

describe('on duty: a second meeting, the office, and a fixed meeting time', () => {
  let env: TestEnv;
  const day = pastMonday();
  let me: AuthUser;
  let dutyId: string;

  const punch = (kind: 'check_in' | 'check_out', hhmm: string, loc = SITE) =>
    env.app.get(AttendanceService).punch(me, kind, { ...loc, accuracyM: 10, source: 'web' }, istInstant(day, hhmm));
  const status = (hhmm: string) => env.app.get(OdHomeService).today(me, istInstant(day, hhmm)) as Promise<any>;
  const addStop = (hhmm: string, body: any) => env.app.get(OdHomeService).addStop(me, body, istInstant(day, hhmm)) as Promise<any>;
  const dayRow = async () => (await env.db.one('select * from attendance_days where employee_id = $1 and work_date = $2', [env.ids.priya, day]))!;

  beforeAll(async () => { env = await createTestEnv(); });
  beforeEach(async () => {
    await env.reset();
    await env.db.query('delete from holidays');
    await env.db.query(`insert into approval_workflows (request_type, name) values ('od_home', 'Going home after duty')`);
    await env.db.query(`insert into approval_workflow_steps (workflow_id, step_order, approver_kind, sla_hours)
                        select id, 1, 'reporting_manager', 24 from approval_workflows where request_type = 'od_home'`);
    await env.db.query('delete from geofences');
    const office = (await env.db.one(`insert into geofences (name, latitude, longitude, radius_m) values ('Head office - Chennai', $1, $2, 150) returning id`, [OFFICE.latitude, OFFICE.longitude]))!.id;
    await env.db.query('update employees set work_location_id = $2, location_consent_at = now() where id = $1', [env.ids.priya, office]);
    dutyId = (await env.db.one(
      `insert into od_requests (employee_id, kind, from_date, to_date, location, purpose, status, meeting_time)
       values ($1,'od',$2,$2,'Startup summit, Ponneri','Summit','approved','10:30') returning id`, [env.ids.priya, day]))!.id;
    const r = (await env.db.one('select id, emp_code, full_name, official_email, department_id, reporting_manager_id from employees where id = $1', [env.ids.priya]))!;
    me = { id: r.id, empCode: r.emp_code, fullName: r.full_name, email: r.official_email, roles: [], departmentId: r.department_id, reportingManagerId: r.reporting_manager_id };
  });
  afterAll(() => env.close());

  it('takes a meeting time on the request and shows it to the approver', async () => {
    const ahead = futureMonday();
    const priya = await env.as('priya');
    const res = await priya.post('/api/od/requests').send({ kind: 'od', fromDate: ahead, purpose: 'Visit', location: 'Madurai', meetingTime: '10:30' });
    expect(res.status).toBe(201);
    expect(res.body.meetingTime).toBe('10:30');
    const approval = await env.db.one('select summary from approval_requests where ref_id = $1', [res.body.id]);
    expect(approval!.summary).toContain('to be there by 10:30');
    const bad = await priya.post('/api/od/requests').send({ kind: 'od', fromDate: ahead, purpose: 'Visit', location: 'Madurai', meetingTime: '25:00' });
    expect(bad.status).toBe(400);
  });

  it('does not flag a person who goes straight to the venue and arrives in time, and is never flagged for skipping the office', async () => {
    await punch('check_in', '10:20');
    await punch('check_out', '13:00');
    const d = await dayRow();
    expect(d.status).toBe('od');
    expect(d.late).toBe(false);
    expect(d.flags).not.toContain('late_for_duty');
  });

  it('notes it when the venue is reached well after the time given', async () => {
    await punch('check_in', '11:20');
    await punch('check_out', '13:00');
    expect((await dayRow()).flags).toContain('late_for_duty');
  });

  it('adds a second meeting after the first is finished, and ties the next check-in to it', async () => {
    await punch('check_in', '10:20');
    await expect(addStop('11:00', { location: 'TiE Chennai, Guindy' })).rejects.toMatchObject({ response: { code: 'DUTY_NOT_FINISHED' } });
    await punch('check_out', '12:30');
    const s = await addStop('12:35', { location: 'TiE Chennai, Guindy', meetingTime: '14:00', purpose: 'Mentor meet' });
    expect(s).toMatchObject({ state: 'next_stop' });
    expect(s.stops).toMatchObject([{ location: 'TiE Chennai, Guindy', meetingTime: '14:00', current: true }]);
    await expect(addStop('12:36', { location: 'Elsewhere' })).rejects.toMatchObject({ response: { code: 'STOP_ALREADY_ADDED' } });

    await punch('check_in', '13:50', SECOND);
    expect(await status('14:00')).toMatchObject({ state: 'on_site' });
    await punch('check_out', '15:30', SECOND);
    expect(await status('15:31')).toMatchObject({ state: 'finished' });

    const view = await env.app.get(OdService).getOne(dutyId);
    expect(view.stops.map((x) => x.location)).toEqual(['TiE Chennai, Guindy']);
    expect(view.siteVisits).toHaveLength(4);
    const ev = await env.db.rows('select od_stop_id from attendance_events where employee_id = $1 order by event_at', [env.ids.priya]);
    expect(ev.map((e) => e.od_stop_id === null)).toEqual([true, true, false, false]);
  });

  it('adds the duty hours and the office hours together when the person returns to the office', async () => {
    await punch('check_in', '10:20');
    await punch('check_out', '13:20');
    expect(await status('13:30')).toMatchObject({ state: 'finished' });

    await punch('check_in', '14:20', OFFICE);
    expect(await status('14:30')).toMatchObject({ state: 'at_office' });
    await punch('check_out', '17:20', OFFICE);

    const d = await dayRow();
    expect(d.status).toBe('od');
    expect(d.worked_minutes).toBe(180 + 180);
    // the office punches are not shown as a visit to the duty place
    const view = await env.app.get(OdService).getOne(dutyId);
    expect(view.siteVisits).toHaveLength(2);
    // and going home needs no approval once they are at the office
    await expect(env.app.get(OdHomeService).apply(me, {}, istInstant(day, '17:25'))).rejects.toMatchObject({ response: { code: 'DUTY_NOT_FINISHED' } });
  });

  it('lets a person who added a meeting change their mind and go to the office', async () => {
    await punch('check_in', '10:20');
    await punch('check_out', '12:30');
    await addStop('12:35', { location: 'Somewhere' });
    await punch('check_in', '13:30', OFFICE);
    expect(await status('13:31')).toMatchObject({ state: 'at_office' });
  });

  it('will not add a meeting while a request to go home is waiting or approved', async () => {
    await punch('check_in', '10:20');
    await punch('check_out', '16:40');
    await env.app.get(OdHomeService).apply(me, { reason: 'Far' }, istInstant(day, '16:41'));
    await expect(addStop('16:42', { location: 'Late meeting' })).rejects.toMatchObject({ response: { code: 'ALREADY_ASKED' } });
    void decide;
  });
});
