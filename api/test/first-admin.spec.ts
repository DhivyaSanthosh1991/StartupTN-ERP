import { createFirstAdmin } from '../src/db/first-admin';
import { TestEnv, createTestEnv, resetData } from './helpers';

describe('starting a new installation', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
  });
  beforeEach(async () => {
    await resetData(env.db); // an empty organisation, as on first deploy
  });
  afterAll(async () => {
    await env.reset();
    await env.close();
  });

  const input = { email: 'Asha@StartupTN.in', fullName: 'Asha Devi', empCode: 'E001' };

  it('creates the first person with HR and system administrator roles, and they can sign in', async () => {
    await createFirstAdmin(env.db, input, 'startuptn.in');
    const asha = await env.as('asha');
    const me = (await asha.get('/api/me')).body;
    expect(me.fullName).toBe('Asha Devi');
    expect(me.roles).toEqual(expect.arrayContaining(['hr_admin', 'super_admin']));
    // and from there can add the rest of the organisation
    const created = await asha.post('/api/employees').send({
      empCode: 'E002', fullName: 'Ravi Kumar', officialEmail: 'ravi@startuptn.in', dateOfJoining: '2025-01-06',
    });
    expect(created.status).toBe(201);
  });

  it('records who the first administrator is in the audit log', async () => {
    const id = await createFirstAdmin(env.db, input, 'startuptn.in');
    const { rows } = await env.db.query(`select action, after_data from audit_log where entity_id = $1`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('employee.create_first_admin');
    expect(rows[0].after_data.email).toBe('asha@startuptn.in');
  });

  it('refuses once anyone exists, so it cannot be used to hand out admin rights later', async () => {
    await createFirstAdmin(env.db, input, 'startuptn.in');
    await expect(createFirstAdmin(env.db, { ...input, email: 'other@startuptn.in', empCode: 'E009' }, 'startuptn.in'))
      .rejects.toThrow(/already exist/);
  });

  it('refuses an address that could never sign in', async () => {
    await expect(createFirstAdmin(env.db, { ...input, email: 'asha@gmail.com' }, 'startuptn.in')).rejects.toThrow(/domain/);
    await expect(createFirstAdmin(env.db, { ...input, email: 'not-an-email' }, 'startuptn.in')).rejects.toThrow(/email/);
    await expect(createFirstAdmin(env.db, { ...input, fullName: '  ' }, 'startuptn.in')).rejects.toThrow(/name/);
    expect((await env.db.query('select count(*)::int as n from employees')).rows[0].n).toBe(0);
  });
});
