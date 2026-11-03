import { AttendanceService } from '../src/attendance/attendance.service';
import { istInstant } from '../src/common/dates';
import { assignWorkLocations, ImportedPerson } from '../src/db/employee-import';
import { TestEnv, createTestEnv } from './helpers';
import { pastMonday } from './dates';

const CHENNAI = { latitude: 13.0827, longitude: 80.2707 };
const MADURAI = { latitude: 9.93619, longitude: 78.13893 };

describe('each person\'s own work location', () => {
  let env: TestEnv;
  const monday = pastMonday();
  let chennaiId: string;
  let maduraiId: string;
  const punchAs = async (id: string, loc: { latitude: number; longitude: number }) => {
    const r = (await env.db.one('select id, emp_code, full_name, official_email from employees where id = $1', [id]))!;
    await env.db.query('update employees set location_consent_at = now() where id = $1', [id]);
    await env.app.get(AttendanceService).punch(
      { id, empCode: r.emp_code, fullName: r.full_name, email: r.official_email, roles: [], departmentId: null, reportingManagerId: null },
      'check_in', { ...loc, accuracyM: 10, source: 'web' }, istInstant(monday, '09:30'));
    return env.db.one('select within_geofence, flags from attendance_events where employee_id = $1', [id]);
  };

  beforeAll(async () => { env = await createTestEnv(); });
  beforeEach(async () => {
    await env.reset();
    await env.db.query('delete from geofences');
    chennaiId = (await env.db.one(`insert into geofences (name, latitude, longitude, radius_m) values ('Head office - Chennai', $1, $2, 150) returning id`, [CHENNAI.latitude, CHENNAI.longitude]))!.id;
    maduraiId = (await env.db.one(`insert into geofences (name, latitude, longitude, radius_m) values ('Madurai Regional Hub', $1, $2, 150) returning id`, [MADURAI.latitude, MADURAI.longitude]))!.id;
  });
  afterAll(() => env.close());

  it('accepts a check-in at the person\'s own location', async () => {
    await env.db.query('update employees set work_location_id = $2 where id = $1', [env.ids.priya, maduraiId]);
    expect(await punchAs(env.ids.priya, MADURAI)).toMatchObject({ within_geofence: true, flags: [] });
  });

  it('flags a check-in at another location, even a real one', async () => {
    await env.db.query('update employees set work_location_id = $2 where id = $1', [env.ids.priya, maduraiId]);
    const e = await punchAs(env.ids.priya, CHENNAI);
    expect(e).toMatchObject({ within_geofence: false });
    expect(e!.flags).toContain('outside_geofence');
  });

  it('with no work location set, any location counts', async () => {
    expect(await punchAs(env.ids.priya, MADURAI)).toMatchObject({ within_geofence: true });
  });

  it('sets work locations from the staff list by place name, and says what it could not match', async () => {
    await env.db.query(`update employees set official_email = 'asha@startuptn.in' where id = $1`, [env.ids.priya]);
    await env.db.query(`update employees set emp_code = 'PENDING-02' where id = $1`, [env.ids.ravi]);
    const person = (over: Partial<ImportedPerson>): ImportedPerson => ({
      empCode: 'X', fullName: 'X', email: 'x@startuptn.in', designation: null, department: null, joined: null, phone: null, workLocation: null, ...over });
    const r = await assignWorkLocations(env.db, [
      person({ fullName: 'Asha', email: 'asha@startuptn.in', workLocation: 'Madurai' }),
      person({ fullName: 'No email', empCode: 'PENDING-02', email: 'pending-02@no-email.invalid', workLocation: 'Chennai' }),
      person({ fullName: 'Far away', workLocation: 'Leh' }),
      person({ fullName: 'Blank' }),
      person({ fullName: 'Ghost', email: 'ghost@startuptn.in', workLocation: 'Chennai' }),
    ]);
    expect(r.set).toBe(2);
    expect([...r.unmatchedPlaces.keys()]).toEqual(['Leh']);
    expect(r.noPlace).toBe(1);
    expect(r.notFound).toEqual(['Ghost']);
    expect((await env.db.one('select work_location_id from employees where id = $1', [env.ids.priya]))!.work_location_id).toBe(maduraiId);
    expect((await env.db.one('select work_location_id from employees where id = $1', [env.ids.ravi]))!.work_location_id).toBe(chennaiId);
  });

  it('matches "Trichy (Addl Charge -Thanjavur)" to the Trichy location', async () => {
    const tid = (await env.db.one(`insert into geofences (name, latitude, longitude, radius_m) values ('Trichy Regional Hub', 10.8, 78.67, 150) returning id`))!.id;
    await env.db.query(`update employees set official_email = 'asha@startuptn.in' where id = $1`, [env.ids.priya]);
    await assignWorkLocations(env.db, [{ empCode: 'X', fullName: 'A', email: 'asha@startuptn.in', designation: null, department: null, joined: null, phone: null, workLocation: 'Trichy (Addl Charge -Thanjavur)' }]);
    expect((await env.db.one('select work_location_id from employees where id = $1', [env.ids.priya]))!.work_location_id).toBe(tid);
  });
});
