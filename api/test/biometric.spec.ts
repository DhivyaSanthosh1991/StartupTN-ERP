import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { AuthUser } from '../src/common/auth.types';
import { addDays, istInstant, todayIst } from '../src/common/dates';
import { AttendanceService } from '../src/attendance/attendance.service';
import { DemoIds } from '../src/db/seed';
import { pastMonday } from './dates';
import { TestEnv, createTestEnv, testConfig } from './helpers';

const OFFICE = { latitude: 13.0827, longitude: 80.2707 };
const MADURAI = { latitude: 9.9252, longitude: 78.1198 };
const jpeg = (fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4_000, fill), Buffer.from([0xff, 0xd9])]).toString('base64');

describe('biometric machine and on-duty selfies', () => {
  let env: TestEnv;
  let att: AttendanceService;
  const monday = pastMonday();
  const tuesday = addDays(monday, 1);

  const user = async (key: keyof DemoIds): Promise<AuthUser> => {
    const r = (await env.db.one(
      'select id, emp_code, full_name, official_email, department_id, reporting_manager_id from employees where id = $1', [env.ids[key]]))!;
    return { id: r.id, empCode: r.emp_code, fullName: r.full_name, email: r.official_email, roles: [], departmentId: r.department_id, reportingManagerId: r.reporting_manager_id };
  };
  const onMachine = (key: keyof DemoIds, code: string) =>
    env.db.query(`update employees set attendance_method = 'biometric', biometric_code = $2 where id = $1`, [env.ids[key], code]);
  const upload = async (text: string, as = 'hema', serial?: string) =>
    (await env.as(as)).post('/api/admin/attendance/biometric/import').query(serial ? { serial } : {}).set('Content-Type', 'text/plain').send(text);
  const events = (key: keyof DemoIds, date: string) =>
    env.db.rows(`select event_type, event_at, source, latitude, flags from attendance_events where employee_id = $1 and work_date = $2 order by event_at`, [env.ids[key], date]);
  const dayOf = async (as: string, date: string) =>
    (await (await env.as(as)).get('/api/attendance/me').query({ month: date.slice(0, 7) })).body.days.find((d: any) => d.date === date);
  const clock = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(11, 16);
  const consent = () => env.db.query('update employees set location_consent_at = now(), photo_consent_at = now()');
  const approvedOd = (key: keyof DemoIds, from: string, to = from) =>
    env.db.query(`insert into od_requests (employee_id, kind, from_date, to_date, location, purpose, status) values ($1,'od',$2,$3,'Madurai incubator','Mentor meet','approved')`, [env.ids[key], from, to]);

  beforeAll(async () => {
    env = await createTestEnv();
    att = env.app.get(AttendanceService);
  });
  beforeEach(async () => {
    await env.reset();
    await env.db.query('delete from holidays');
    await (await env.as('hema')).put('/api/admin/settings').send({ selfie_required: true }); // the product default; the shared test reset switches it off
  });
  afterAll(() => env.close());

  describe('who is on the machine', () => {
    it('defaults to the selfie, and needs a machine code before someone can be put on the machine', async () => {
      const hr = await env.as('hema');
      expect((await hr.get(`/api/employees/${env.ids.ravi}`)).body).toMatchObject({ attendanceMethod: 'selfie', biometricCode: null });

      const noCode = await hr.patch(`/api/employees/${env.ids.ravi}`).send({ attendanceMethod: 'biometric' });
      expect(noCode.status).toBe(400);
      expect(noCode.body.code).toBe('BIOMETRIC_CODE_REQUIRED');

      const ok = await hr.patch(`/api/employees/${env.ids.ravi}`).send({ attendanceMethod: 'biometric', biometricCode: ' 1123 ' });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ attendanceMethod: 'biometric', biometricCode: '1123' });

      const removeCode = await hr.patch(`/api/employees/${env.ids.ravi}`).send({ biometricCode: '' });
      expect(removeCode.status).toBe(400);
      expect(removeCode.body.code).toBe('BIOMETRIC_CODE_REQUIRED');
    });

    it('does not let two people share a code', async () => {
      const hr = await env.as('hema');
      await hr.patch(`/api/employees/${env.ids.ravi}`).send({ attendanceMethod: 'biometric', biometricCode: '1123' });
      const clash = await hr.patch(`/api/employees/${env.ids.priya}`).send({ attendanceMethod: 'biometric', biometricCode: '1123' });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('BIOMETRIC_CODE_TAKEN');
    });

    it('can be set when the person is added', async () => {
      const hr = await env.as('hema');
      const made = await hr.post('/api/employees').send({
        empCode: 'E900', fullName: 'Test Person', officialEmail: 'test.person@startuptn.in', attendanceMethod: 'biometric', biometricCode: '900' });
      expect(made.status).toBe(201);
      expect(made.body).toMatchObject({ attendanceMethod: 'biometric', biometricCode: '900' });
      const missing = await hr.post('/api/employees').send({ empCode: 'E901', fullName: 'Other', officialEmail: 'other@startuptn.in', attendanceMethod: 'biometric' });
      expect(missing.status).toBe(400);
    });
  });

  describe('importing punches from the machine', () => {
    beforeEach(() => onMachine('ravi', '1123'));
    const rows = (...times: string[]) => times.map((t) => `1123,${t},BRM9202760325`).join('\n');

    it('makes the first punch of the day the check-in and the last the check-out', async () => {
      const res = await upload(rows(`${monday} 09:05:00`, `${monday} 13:02:10`, `${monday} 18:10:00`));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ rowsRead: 3, inserted: 3, duplicates: 0, unmatched: 0, rejected: 0, daysUpdated: 1 });

      const ev = await events('ravi', monday);
      expect(ev.map((e: any) => [e.event_type, clock(e.event_at), e.source])).toEqual([['check_in', '09:05', 'biometric'], ['check_out', '18:10', 'biometric']]);
      expect(ev[0].latitude).toBeNull();
      expect(await env.db.rows('select 1 from biometric_punches')).toHaveLength(3); // the middle punch is kept, just not an event

      expect(await dayOf('ravi', monday)).toMatchObject({ status: 'present', workedMinutes: 545, late: false });
    });

    it('marks a late arrival late', async () => {
      await upload(rows(`${monday} 10:05:00`, `${monday} 18:30:00`));
      expect((await dayOf('ravi', monday)).late).toBe(true);
    });

    it('treats a lone punch as an arrival with no departure, and two close punches as one visit', async () => {
      await upload(rows(`${monday} 09:05:00`, `${tuesday} 09:00:00`, `${tuesday} 09:03:00`));
      expect(await dayOf('ravi', monday)).toMatchObject({ status: 'incomplete' });
      expect((await dayOf('ravi', monday)).flags).toContain('missing_checkout');
      expect((await events('ravi', tuesday)).map((e: any) => e.event_type)).toEqual(['check_in']);
    });

    it('changes nothing when the same file is imported again', async () => {
      const text = rows(`${monday} 09:05:00`, `${monday} 18:10:00`);
      await upload(text);
      const again = await upload(text);
      expect(again.body).toMatchObject({ rowsRead: 2, inserted: 0, duplicates: 2 });
      expect(await events('ravi', monday)).toHaveLength(2);
      expect(await env.db.rows('select 1 from biometric_punches')).toHaveLength(2);
    });

    it('picks up the check-out when later punches arrive', async () => {
      await upload(rows(`${monday} 09:05:00`));
      expect(await events('ravi', monday)).toHaveLength(1);
      await upload(rows(`${monday} 18:10:00`));
      expect((await events('ravi', monday)).map((e: any) => e.event_type)).toEqual(['check_in', 'check_out']);
    });

    it('keeps punches for someone on the selfie, without making events from them', async () => {
      await env.db.query(`update employees set biometric_code = '2001' where id = $1`, [env.ids.priya]); // method stays 'selfie'
      const res = await upload(`2001,${monday} 09:00:00\n2001,${monday} 18:00:00`);
      expect(res.body).toMatchObject({ inserted: 2, unmatched: 0, daysUpdated: 0 });
      expect(await events('priya', monday)).toHaveLength(0);
    });

    it('keeps punches nobody owns yet, shows them to HR, and uses them once the code is assigned', async () => {
      const res = await upload(`X9,${monday} 09:00:00\nX9,${monday} 17:45:00`);
      expect(res.body).toMatchObject({ inserted: 2, unmatched: 2 });
      const status = (await (await env.as('hema')).get('/api/admin/attendance/biometric')).body;
      expect(status.unmatched).toEqual([expect.objectContaining({ code: 'X9', punches: 2 })]);

      await (await env.as('hema')).patch(`/api/employees/${env.ids.priya}`).send({ attendanceMethod: 'biometric', biometricCode: 'X9' });
      const rebuilt = await (await env.as('hema')).post('/api/admin/attendance/biometric/rebuild').send({ from: monday, to: monday });
      expect(rebuilt.status).toBe(200);
      expect((await events('priya', monday)).map((e: any) => clock(e.event_at))).toEqual(['09:00', '17:45']);
      expect((await (await env.as('hema')).get('/api/admin/attendance/biometric')).body.unmatched).toEqual([]);
    });

    it('leaves a day alone once an approved correction covers it', async () => {
      await env.db.query(
        `insert into attendance_events (employee_id, event_type, event_at, work_date, flags, source) values
           ($1,'check_in',$2,$4,array['regularised'],'regularisation'), ($1,'check_out',$3,$4,array['regularised'],'regularisation')`,
        [env.ids.ravi, istInstant(monday, '09:00'), istInstant(monday, '17:00'), monday]);
      await upload(rows(`${monday} 09:40:00`, `${monday} 18:40:00`));
      expect((await events('ravi', monday)).every((e: any) => e.source === 'regularisation')).toBe(true);
    });

    it('turns the machine\'s events off again when someone moves back to the selfie', async () => {
      await upload(rows(`${monday} 09:05:00`, `${monday} 18:10:00`));
      await env.db.query(`update employees set attendance_method = 'selfie' where id = $1`, [env.ids.ravi]);
      const res = await (await env.as('hema')).post('/api/admin/attendance/biometric/rebuild').send({ from: monday, to: monday });
      expect(res.body.people).toBe(1);
      expect(await events('ravi', monday)).toHaveLength(0);
    });

    it('refuses a file it cannot read, stores nothing, and records the failure', async () => {
      const res = await upload('hello\nthis is not a punch list\nat all');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BIOMETRIC_IMPORT_FAILED');
      expect(res.body.message).toContain('hello');
      expect(await env.db.rows('select 1 from biometric_punches')).toHaveLength(0);
      expect(await env.db.rows(`select 1 from biometric_imports where status = 'failed'`)).toHaveLength(1);
    });

    it('imports the readable rows of a mostly good file and reports the rest', async () => {
      const res = await upload(`${rows(`${monday} 09:05:00`, `${monday} 18:10:00`)}\ngarbage line`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ inserted: 2, rejected: 1 });
      const run = (await (await env.as('hema')).get('/api/admin/attendance/biometric')).body.runs[0];
      expect(run).toMatchObject({ status: 'done', rejected: 1 });
      expect(run.message).toContain('garbage line');
    });

    it('ignores a punch dated well into the future (a wrong clock on the machine)', async () => {
      const res = await upload(`${rows(`${monday} 09:05:00`)}\n1123,${addDays(todayIst(), 5)} 09:00:00`);
      expect(res.body).toMatchObject({ inserted: 1, rejected: 1 });
    });

    it('is for HR only, and needs plain text', async () => {
      expect((await upload(rows(`${monday} 09:05:00`), 'priya')).status).toBe(403);
      expect((await upload(rows(`${monday} 09:05:00`), 'mani')).status).toBe(403);
      const hr = await env.as('hema');
      const empty = await hr.post('/api/admin/attendance/biometric/import').set('Content-Type', 'text/plain').send('   ');
      expect(empty.body.code).toBe('EMPTY_IMPORT');
      const json = await hr.post('/api/admin/attendance/biometric/import').send({ rows: [] });
      expect(json.body.code).toBe('EMPTY_IMPORT');
    });

    it('accepts a month of punches for the whole office in one file', async () => {
      const lines: string[] = [];
      const pad = (n: number) => String(n).padStart(2, '0');
      for (let d = 0; d < 30; d++) {
        for (let c = 0; c < 20; c++) {
          for (let p = 0; p < 30; p++) {
            const secs = 8 * 3600 + p * 60 + c;
            lines.push(`${1100 + c},${addDays('2026-09-01', d)} ${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)},BRM9202760325,in`);
          }
        }
      }
      const text = lines.join('\n');
      expect(text.length).toBeGreaterThan(512 * 1024); // more than an ordinary JSON request may carry
      const res = await upload(text);
      expect(res.status).toBe(200);
      expect(res.body.rowsRead).toBe(18000);
    });
  });

  describe('the portal for people on the machine', () => {
    beforeEach(async () => {
      await onMachine('ravi', '1123');
      await consent();
    });
    const punchAs = async (who: string, body: Record<string, unknown> = {}) =>
      (await env.as(who)).post('/api/attendance/check-in').send({ ...OFFICE, accuracyM: 10, selfie: jpeg(), ...body });

    it('tells the front end who may punch', async () => {
      expect((await (await env.as('ravi')).get('/api/attendance/today')).body).toMatchObject({ attendanceMethod: 'biometric', canPunch: false });
      expect((await (await env.as('priya')).get('/api/attendance/today')).body).toMatchObject({ attendanceMethod: 'selfie', canPunch: true });
    });

    it('does not let them punch in the portal on an ordinary day', async () => {
      const res = await punchAs('ravi');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BIOMETRIC_ONLY');
      expect(await events('ravi', todayIst())).toHaveLength(0);
    });

    it('lets them, and asks for a selfie, on an approved on-duty day', async () => {
      await approvedOd('ravi', todayIst());
      expect((await (await env.as('ravi')).get('/api/attendance/today')).body.canPunch).toBe(true);
      const noPhoto = await (await env.as('ravi')).post('/api/attendance/check-in').send({ ...OFFICE, accuracyM: 10 });
      expect(noPhoto.status).toBe(400);
      expect(noPhoto.body.code).toBe('SELFIE_REQUIRED');
      const ok = await punchAs('ravi', MADURAI);
      expect(ok.status).toBe(200);
      expect(ok.body.events[0]).toMatchObject({ type: 'check_in', selfie: true, source: 'web' });
    });

    it('does not flag being away from the office on an on-duty day, but does on an ordinary one', async () => {
      await env.db.query(`insert into geofences (name, kind, latitude, longitude, radius_m) values ('Head office','office',$1,$2,200)`, [OFFICE.latitude, OFFICE.longitude]);
      await approvedOd('priya', todayIst());
      const onDuty = await punchAs('priya', MADURAI);
      expect(onDuty.body.events[0].flags).not.toContain('outside_geofence');
      expect(onDuty.body.events[0].withinGeofence).toBe(false); // the place is still recorded

      const ordinary = await punchAs('arun', MADURAI);
      expect(ordinary.body.events[0].flags).toContain('outside_geofence');
    });
  });

  describe('on-duty days need a selfie', () => {
    beforeEach(() => consent());
    const flagsOn = async (as: string, date: string) => (await dayOf(as, date)).flags as string[];

    it('flags a finished on-duty day with no selfie, but still counts it as on duty', async () => {
      await approvedOd('priya', monday);
      expect(await dayOf('priya', monday)).toMatchObject({ status: 'od' });
      expect(await flagsOn('priya', monday)).toContain('od_no_selfie');
    });

    it('does not flag it when a selfie check-in was made', async () => {
      await approvedOd('priya', monday);
      await att.punch(await user('priya'), 'check_in', { ...MADURAI, accuracyM: 12, source: 'web', selfie: jpeg() }, istInstant(monday, '09:40'));
      await att.punch(await user('priya'), 'check_out', { ...MADURAI, accuracyM: 12, source: 'web', selfie: jpeg(9) }, istInstant(monday, '17:40'));
      expect(await flagsOn('priya', monday)).not.toContain('od_no_selfie');
    });

    it('does not flag today, a future day, or anything while selfies are switched off', async () => {
      await approvedOd('priya', todayIst(), addDays(todayIst(), 3));
      expect(await flagsOn('priya', todayIst())).not.toContain('od_no_selfie');

      await approvedOd('manager', monday);
      expect(await flagsOn('mani', monday)).toContain('od_no_selfie');
      await (await env.as('hema')).put('/api/admin/settings').send({ selfie_required: false });
      expect(await flagsOn('mani', monday)).not.toContain('od_no_selfie');
    });

    it('does not flag a day an approved correction covers', async () => {
      await approvedOd('priya', monday);
      await env.db.query(
        `insert into attendance_events (employee_id, event_type, event_at, work_date, flags, source) values ($1,'check_in',$2,$3,array['regularised'],'regularisation')`,
        [env.ids.priya, istInstant(monday, '10:00'), monday]);
      expect(await flagsOn('priya', monday)).not.toContain('od_no_selfie');
    });
  });
});

// ------------------------------------------------------------------------------------- the machine's Web API

describe('pulling punches from the machine\'s Web API', () => {
  let env: TestEnv;
  let server: Server;
  let requests: { headers: IncomingMessage['headers']; body: string }[];
  let respond: (serial: string, body: string) => { status?: number; xml: string };
  const monday = pastMonday();

  const soap = (inner: string) =>
    `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetTransactionsLogResponse xmlns="http://tempuri.org/">${inner}</GetTransactionsLogResponse></soap:Body></soap:Envelope>`;
  const escaped = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ok = (rows: string) => soap(`<GetTransactionsLogResult>Success</GetTransactionsLogResult><strDataList>${escaped(rows)}</strDataList>`);

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        requests.push({ headers: req.headers, body });
        const serial = /<SerialNumber>([^<]*)<\/SerialNumber>/.exec(body)?.[1] ?? '';
        const out = respond(serial, body);
        res.writeHead(out.status ?? 200, { 'Content-Type': 'text/xml; charset=utf-8' }).end(out.xml);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    env = await createTestEnv({
      biometricApiUrl: `http://127.0.0.1:${port}/iclock/WebAPIService.asmx`,
      biometricApiUser: 'Test', biometricApiPassword: 'Te&st<1>', biometricDeviceSerials: ['BRM1', 'BRM2'], biometricLookbackDays: 2,
    });
  });
  beforeEach(async () => {
    await env.reset();
    await env.db.query(`update employees set attendance_method = 'biometric', biometric_code = '1123' where id = $1`, [env.ids.ravi]);
    requests = [];
    respond = () => ({ xml: ok('') });
  });
  afterAll(async () => {
    await env.close();
    await new Promise((r) => server.close(r));
  });
  afterEach(() => undefined);

  const sync = async () => (await (await env.as('hema')).post('/api/admin/attendance/biometric/sync'));

  it('asks each machine for the last few days with the documented SOAP call', async () => {
    const res = await sync();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: true, devices: 2, failed: 0 });
    expect(requests).toHaveLength(2);
    const first = requests[0];
    expect(first.headers.soapaction).toBe('"http://tempuri.org/GetTransactionsLog"');
    expect(first.headers['content-type']).toContain('text/xml');
    const slash = (d: string) => d.replace(/-/g, '/');
    expect(first.body).toContain(`<FromDate>${slash(addDays(todayIst(), -2))}</FromDate>`);
    expect(first.body).toContain(`<ToDate>${slash(todayIst())}</ToDate>`);
    expect(first.body).toContain('<SerialNumber>BRM1</SerialNumber>');
    expect(requests[1].body).toContain('<SerialNumber>BRM2</SerialNumber>');
    expect(first.body).toContain('<UserName>Test</UserName>');
    expect(first.body).toContain('<UserPassword>Te&amp;st&lt;1&gt;</UserPassword>'); // sent safely escaped
  });

  it('turns what the machine returns into attendance', async () => {
    respond = (serial) => ({ xml: ok(serial === 'BRM1' ? `1123,${monday} 09:02:00,BRM1,in\n1123,${monday} 18:05:00,BRM1,out` : '') });
    const res = await sync();
    expect(res.body).toMatchObject({ inserted: 2, failed: 0 });
    const ev = await env.db.rows(`select event_type, source from attendance_events where employee_id = $1 and work_date = $2 order by event_at`, [env.ids.ravi, monday]);
    expect(ev.map((e: any) => [e.event_type, e.source])).toEqual([['check_in', 'biometric'], ['check_out', 'biometric']]);
    const status = (await (await env.as('hema')).get('/api/admin/attendance/biometric')).body;
    expect(status.devices.map((d: any) => [d.serial, !!d.lastOkAt, d.lastError])).toEqual([['BRM1', true, null], ['BRM2', true, null]]);
    expect(status.runs).toHaveLength(1); // the pull that found nothing new left no row
  });

  it('also reads punches the machine returns in the result element', async () => {
    respond = (serial) => ({ xml: soap(`<GetTransactionsLogResult>${escaped(serial === 'BRM1' ? `1123,${monday} 09:02:00` : '')}</GetTransactionsLogResult><strDataList>Blank</strDataList>`) });
    expect((await sync()).body.inserted).toBe(1);
  });

  it('reports a machine that refuses the login, and carries on with the others', async () => {
    respond = (serial) => serial === 'BRM1'
      ? { xml: soap('<GetTransactionsLogResult>Authentication failure</GetTransactionsLogResult><strDataList></strDataList>') }
      : { xml: ok(`1123,${monday} 09:30:00`) };
    const res = await sync();
    expect(res.body).toMatchObject({ failed: 1, inserted: 1 });
    expect(res.body.messages[0]).toMatch(/BRM1.*refused the user name or password/);
    const status = (await (await env.as('hema')).get('/api/admin/attendance/biometric')).body;
    expect(status.devices[0]).toMatchObject({ serial: 'BRM1', lastOkAt: null });
    expect(status.devices[0].lastError).toMatch(/refused/);
    expect(status.devices[1].lastError).toBeNull();
  });

  it('reports a server that errors or sends something unreadable, without storing anything', async () => {
    respond = (serial) => serial === 'BRM1' ? { status: 500, xml: '<faultstring>Object reference not set</faultstring>' } : { xml: ok('row one at 09:10 today\nrow two at 18:00 today') };
    const res = await sync();
    expect(res.body.failed).toBe(2);
    expect(res.body.messages.join(' ')).toMatch(/answered 500.*Object reference/);
    expect(res.body.messages.join(' ')).toMatch(/could not be read/);
    expect(await env.db.rows('select 1 from biometric_punches')).toHaveLength(0);
  });

  it('can be started by the schedule with the jobs token, and only then', async () => {
    respond = () => ({ xml: ok(`1123,${monday} 09:00:00,BRM1`) });
    expect((await env.anon().post('/api/jobs/biometric-sync')).status).toBe(401);
    const run = await env.anon().post('/api/jobs/biometric-sync').set('x-jobs-token', testConfig.jobsToken);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ configured: true, devices: 2 });
    expect((await (await env.as('priya')).post('/api/admin/attendance/biometric/sync')).status).toBe(403);
  });

  it('shows who is on the machine and what is connected', async () => {
    const status = (await (await env.as('hema')).get('/api/admin/attendance/biometric')).body;
    expect(status).toMatchObject({ configured: true, lookbackDays: 2, people: { biometric: 1 } });
    expect(status.server).toMatch(/^127\.0\.0\.1:\d+$/); // the address, never the password
    expect(JSON.stringify(status)).not.toContain('Te&st');
  });
});

describe('without a machine connection', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await createTestEnv(); });
  afterAll(() => env.close());

  it('does nothing when the schedule calls, and says it is not connected', async () => {
    const run = await env.anon().post('/api/jobs/biometric-sync').set('x-jobs-token', testConfig.jobsToken);
    expect(run.body).toEqual({ configured: false, devices: 0, inserted: 0, failed: 0, messages: [] });
    const status = (await (await env.as('hema')).get('/api/admin/attendance/biometric')).body;
    expect(status).toMatchObject({ configured: false, server: null, devices: [] });
  });
});
