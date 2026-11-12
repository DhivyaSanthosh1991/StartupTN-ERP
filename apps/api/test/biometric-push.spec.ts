import { TestEnv, createTestEnv, testConfig } from './helpers';

describe('punches pushed from the biometric PC', () => {
  let env: TestEnv;
  const push = (body: string, token: string | null = testConfig.biometricPushToken, query: Record<string, string> = {}) => {
    const r = env.anon().post('/api/jobs/biometric-push').query(query).set('Content-Type', 'text/plain');
    if (token) r.set('x-push-token', token);
    return r.send(body);
  };
  const LINES = ['code,time,direction', '1123,2026-11-02 10:34:09,in', '1123,2026-11-02 19:03:44,out', '9999,2026-11-02 10:00:00,in'].join('\n');

  beforeAll(async () => { env = await createTestEnv(); });
  beforeEach(async () => {
    await env.reset();
    await env.db.query('delete from holidays');
    await env.db.query(`update employees set attendance_method = 'biometric', biometric_code = '1123' where id = $1`, [env.ids.priya]);
  });
  afterAll(() => env.close());

  it('needs the secret', async () => {
    expect((await push(LINES, null)).status).toBe(401);
    expect((await push(LINES, 'not-the-secret-not-the-secret')).status).toBe(401);
    expect((await push(LINES, '')).status).toBe(401);
  });

  it('adds the punches, keeps those nobody owns for HR to link, and brings the day up to date', async () => {
    const res = await push(LINES, undefined, { serial: 'AJXM123456' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ inserted: 3, unmatched: 1, rejected: 0 });
    const day = await env.db.one(`select worked_minutes from attendance_days where employee_id = $1 and work_date = '2026-11-02'`, [env.ids.priya]);
    expect(day).toMatchObject({ worked_minutes: 510 });
    const run = await env.db.one(`select source, device_serial from biometric_imports order by started_at desc limit 1`);
    expect(run).toMatchObject({ source: 'api', device_serial: 'AJXM123456' });
  });

  it('can be sent again, and again with some new punches, without doubling anything', async () => {
    await push(LINES);
    const again = await push(LINES);
    expect(again.body).toMatchObject({ inserted: 0, duplicates: 3 });
    const more = await push(LINES + '\n1123,2026-11-03 09:00:00,in');
    expect(more.body).toMatchObject({ inserted: 1 });
  });

  it('refuses an empty body', async () => {
    expect((await push('   ')).status).toBe(400);
  });

  it('does not exist while no secret is set, or while it is too short to be safe', async () => {
    for (const token of ['', 'short']) {
      const bare = await createTestEnv({ biometricPushToken: token });
      try {
        const res = await bare.anon().post('/api/jobs/biometric-push').set('x-push-token', token || 'anything-anything-1234').set('Content-Type', 'text/plain').send(LINES);
        expect(res.status).toBe(404);
      } finally {
        await bare.close();
      }
    }
  });
});
