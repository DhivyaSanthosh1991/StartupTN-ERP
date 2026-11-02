import { TestEnv, createTestEnv } from './helpers';

describe('employee master', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
  });
  beforeEach(() => env.reset());
  afterAll(() => env.close());

  describe('directory and detail access', () => {
    it('any employee can search the directory, which hides personal details', async () => {
      const priya = await env.as('priya');
      const res = await priya.get('/api/employees/directory').query({ search: 'hari' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].fullName).toBe('Hari Prasad');
      expect(res.body[0].dateOfBirth).toBeUndefined();
      expect(res.body[0].phone).toBeUndefined();
    });

    it.each([
      ['themself', 'priya', 'priya', 200],
      ['their reporting manager', 'manager', 'priya', 200],
      ['their manager\'s manager', 'opsHead', 'priya', 200],
      ['their department head (hod role)', 'opsHead', 'ravi', 200],
      ['HR', 'hr', 'priya', 200],
      ['a peer', 'ravi', 'priya', 403],
      ['the head of another department', 'invHead', 'priya', 403],
    ])('lets %s view an employee record: %s', async (_label, viewer, target, status) => {
      const names: Record<string, string> = {
        priya: 'priya', ravi: 'ravi', manager: 'mani', opsHead: 'hari', hr: 'hema', invHead: 'arun',
      };
      const agent = await env.as(names[viewer]);
      const res = await agent.get(`/api/employees/${(env.ids as any)[target]}`);
      expect(res.status).toBe(status);
    });

    it('only HR and the system administrator can list every employee', async () => {
      expect((await (await env.as('priya')).get('/api/employees')).status).toBe(403);
      expect((await (await env.as('mani')).get('/api/employees')).status).toBe(403);
      expect((await (await env.as('sathya')).get('/api/employees')).status).toBe(200);
      const hr = await env.as('hema');
      const res = await hr.get('/api/employees');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(9);
    });

    it('a manager can list their direct reports', async () => {
      const mani = await env.as('mani');
      const res = await mani.get('/api/me/team');
      expect(res.body.map((e: any) => e.fullName).sort()).toEqual(['Priya Raman', 'Ravi Kumar']);
      const me = await mani.get('/api/me');
      expect(me.body.isManager).toBe(true);
    });
  });

  describe('HR maintenance', () => {
    const newHire = {
      empCode: 'E100',
      fullName: 'Kavya Nair',
      officialEmail: 'Kavya@StartupTN.in',
      designation: 'Executive',
      employmentType: 'contract',
      dateOfJoining: '2026-11-02',
    };

    it('creates an employee, normalises the email, and records an audit entry', async () => {
      const hr = await env.as('hema');
      const res = await hr.post('/api/employees').send({ ...newHire, reportingManagerId: env.ids.manager });
      expect(res.status).toBe(201);
      expect(res.body.officialEmail).toBe('kavya@startuptn.in');
      expect(res.body.reportingManagerName).toBe('Mani Kandan');

      const audit = await env.db.rows(`select action, actor_id from audit_log where entity_id = $1`, [res.body.id]);
      expect(audit).toEqual([{ action: 'employee.create', actor_id: env.ids.hr }]);
    });

    it('refuses duplicate emails and codes', async () => {
      const hr = await env.as('hema');
      await hr.post('/api/employees').send(newHire).expect(201);
      const dupEmail = await hr.post('/api/employees').send({ ...newHire, empCode: 'E101' });
      expect(dupEmail.status).toBe(409);
      expect(dupEmail.body.code).toBe('EMAIL_TAKEN');
      const dupCode = await hr.post('/api/employees').send({ ...newHire, officialEmail: 'other@startuptn.in' });
      expect(dupCode.status).toBe(409);
      expect(dupCode.body.code).toBe('EMP_CODE_TAKEN');
    });

    it('validates input and says which field is wrong', async () => {
      const hr = await env.as('hema');
      const res = await hr.post('/api/employees').send({ empCode: '', fullName: 'X', officialEmail: 'not-an-email', dateOfJoining: '2026-13-45' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION');
      const fields = res.body.issues.map((i: any) => i.path);
      expect(fields).toEqual(expect.arrayContaining(['empCode', 'officialEmail', 'dateOfJoining']));
    });

    it('non-HR staff cannot create or edit employees', async () => {
      const priya = await env.as('priya');
      expect((await priya.post('/api/employees').send(newHire)).status).toBe(403);
      expect((await priya.patch(`/api/employees/${env.ids.priya}`).send({ designation: 'CEO' })).status).toBe(403);
    });

    it('blocks reporting loops', async () => {
      const hr = await env.as('hema');
      // Meena (MD) is above Priya; making Meena report to Priya would be a loop.
      const res = await hr.patch(`/api/employees/${env.ids.md}`).send({ reportingManagerId: env.ids.priya });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MANAGER_LOOP');
      const self = await hr.patch(`/api/employees/${env.ids.priya}`).send({ reportingManagerId: env.ids.priya });
      expect(self.body.code).toBe('MANAGER_LOOP');
    });

    it('records before/after values when an employee changes', async () => {
      const hr = await env.as('hema');
      await hr.patch(`/api/employees/${env.ids.priya}`).send({ designation: 'Senior Executive' }).expect(200);
      const [row] = await env.db.rows(`select before_data, after_data from audit_log where action = 'employee.update'`);
      expect(row.before_data).toEqual({ designation: 'Executive, Operations' });
      expect(row.after_data).toEqual({ designation: 'Senior Executive' });
    });

    it('stamps an exit date when someone is marked exited, and HR cannot deactivate themself', async () => {
      const hr = await env.as('hema');
      const res = await hr.patch(`/api/employees/${env.ids.ravi}`).send({ status: 'exited' });
      expect(res.body.status).toBe('exited');
      expect(res.body.exitDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const self = await hr.patch(`/api/employees/${env.ids.hr}`).send({ status: 'inactive' });
      expect(self.body.code).toBe('CANNOT_DEACTIVATE_SELF');
    });
  });

  describe('roles', () => {
    it('only a super admin can change roles', async () => {
      const body = { roles: ['hr_admin'] };
      expect((await (await env.as('hema')).put(`/api/employees/${env.ids.priya}/roles`).send(body)).status).toBe(403);
      const admin = await env.as('sathya');
      const res = await admin.put(`/api/employees/${env.ids.priya}/roles`).send(body);
      expect(res.status).toBe(200);
      expect(res.body.roles).toEqual(['hr_admin']);
    });

    it('a super admin cannot strip their own super admin role', async () => {
      const admin = await env.as('sathya');
      const res = await admin.put(`/api/employees/${env.ids.admin}/roles`).send({ roles: [] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CANNOT_REMOVE_OWN_SUPER_ADMIN');
    });
  });

  it('records location consent once and keeps the first timestamp', async () => {
    const priya = await env.as('priya');
    expect((await priya.get('/api/me')).body.locationConsentAt).toBeNull();
    const first = await priya.post('/api/me/location-consent');
    expect(first.body.locationConsentAt).toBeTruthy();
    const second = await priya.post('/api/me/location-consent');
    expect(second.body.locationConsentAt).toBe(first.body.locationConsentAt);
  });

  it('the audit log cannot be edited or deleted, even directly in SQL', async () => {
    const hr = await env.as('hema');
    await hr.patch(`/api/employees/${env.ids.priya}`).send({ designation: 'Lead' }).expect(200);
    await expect(env.db.query(`update audit_log set action = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(env.db.query(`delete from audit_log`)).rejects.toThrow(/append-only/);
  });
});

describe('organisation data', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await createTestEnv(); });
  beforeEach(() => env.reset());
  afterAll(() => env.close());

  it('HR manages holidays; everyone can read them', async () => {
    const hr = await env.as('hema');
    const add = await hr.post('/api/admin/holidays').send({ date: '2027-04-14', name: 'Tamil New Year' });
    expect(add.status).toBe(201);
    expect((await hr.post('/api/admin/holidays').send({ date: '2027-04-14', name: 'Dup' })).body.code).toBe('HOLIDAY_EXISTS');

    const list = await (await env.as('priya')).get('/api/holidays').query({ year: 2027 });
    expect(list.body.map((h: any) => h.name)).toContain('Tamil New Year');
    expect((await (await env.as('priya')).post('/api/admin/holidays').send({ date: '2027-05-01', name: 'x' })).status).toBe(403);

    expect((await hr.delete(`/api/admin/holidays/${add.body.id}`)).status).toBe(204);
  });

  it('settings validate their ranges and take effect immediately', async () => {
    const hr = await env.as('hema');
    const bad = await hr.put('/api/admin/settings').send({ grace_minutes: 9999 });
    expect(bad.status).toBe(400);
    const crossed = await hr.put('/api/admin/settings').send({ half_day_minutes: 500, full_day_minutes: 300 });
    expect(crossed.body.code).toBe('BAD_SETTINGS');
    const ok = await hr.put('/api/admin/settings').send({ grace_minutes: 10, weekly_off_days: [0] });
    expect(ok.status).toBe(200);
    expect(ok.body.grace_minutes).toBe(10);
    expect((await hr.get('/api/admin/settings')).body.weekly_off_days).toEqual([0]);
  });

  it('shows departments with head and headcount, and lets HR create more', async () => {
    const hr = await env.as('hema');
    const list = await hr.get('/api/departments');
    const ops = list.body.find((d: any) => d.name === 'Operations');
    expect(ops.headName).toBe('Hari Prasad');
    expect(ops.headcount).toBe(4);
    const created = await hr.post('/api/admin/departments').send({ name: 'Programs' });
    expect(created.status).toBe(201);
    expect((await hr.post('/api/admin/departments').send({ name: 'Programs' })).body.code).toBe('DEPARTMENT_EXISTS');
  });

  it('notices can be posted by HR and are visible to all until they expire', async () => {
    const hr = await env.as('hema');
    await hr.post('/api/admin/notices').send({ title: 'Diwali schedule', body: 'Office closes at 1pm' }).expect(201);
    await hr.post('/api/admin/notices').send({ title: 'Old news', body: 'x', expiresOn: '2020-01-01' }).expect(201);
    const res = await (await env.as('priya')).get('/api/notices');
    const titles = res.body.map((n: any) => n.title);
    expect(titles).toContain('Diwali schedule');
    expect(titles).not.toContain('Old news');
  });

  it('only HR and super admin can read the audit log', async () => {
    expect((await (await env.as('priya')).get('/api/admin/audit')).status).toBe(403);
    expect((await (await env.as('hema')).get('/api/admin/audit')).status).toBe(200);
    expect((await (await env.as('sathya')).get('/api/admin/audit')).status).toBe(200);
  });
});
