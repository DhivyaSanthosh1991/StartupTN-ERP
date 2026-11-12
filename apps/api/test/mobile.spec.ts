import { TestEnv, createTestEnv } from './helpers';
import request from 'supertest';

describe('phone app support', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await createTestEnv(); });
  beforeEach(async () => { await env.reset(); });
  afterAll(() => env.close());

  it('gives the app a token to keep, and a browser only a cookie', async () => {
    const app = await env.anon().post('/api/auth/dev-login').set('x-client', 'mobile').send({ email: 'priya@startuptn.in' });
    expect(app.status).toBe(200);
    expect(typeof app.body.token).toBe('string');
    expect(app.headers['set-cookie']).toBeUndefined();

    const web = await env.anon().post('/api/auth/dev-login').send({ email: 'priya@startuptn.in' });
    expect(web.body.token).toBeUndefined();
    expect(web.headers['set-cookie']).toBeDefined();
  });

  it('accepts that token as a bearer token', async () => {
    const login = await env.anon().post('/api/auth/dev-login').set('x-client', 'mobile').send({ email: 'priya@startuptn.in' });
    const res = await request(env.app.getHttpServer()).get('/api/attendance/today').set('Authorization', `Bearer ${login.body.token}`).set('x-client', 'mobile');
    expect(res.status).toBe(200);
  });

  it('remembers a phone once, moves it to whoever signs in on it, and forgets it', async () => {
    const priya = await env.as('priya');
    const body = { pushToken: 'ExponentPushToken[abcdefghijkl]', platform: 'android', appVersion: '1.0.0' };
    expect((await priya.post('/api/devices').send(body)).status).toBe(200);
    expect((await priya.post('/api/devices').send(body)).status).toBe(200);
    expect((await env.db.query('select 1 from devices')).rows).toHaveLength(1);

    const other = await env.as('hema');
    await other.post('/api/devices').send(body);
    const row = await env.db.one('select employee_id from devices');
    expect(row.employee_id).not.toBe(env.ids.priya);

    expect((await other.delete('/api/devices').query({ token: body.pushToken })).status).toBe(204);
    expect((await env.db.query('select 1 from devices')).rows).toHaveLength(0);
  });

  it('rejects a malformed device registration', async () => {
    const priya = await env.as('priya');
    expect((await priya.post('/api/devices').send({ pushToken: 'x', platform: 'windows' })).status).toBe(400);
  });
});

describe('app-only mode', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await createTestEnv({ requireMobileApp: true }); });
  beforeEach(async () => { await env.reset(); });
  afterAll(() => env.close());

  it('stops check-in, breaks and tracking from the browser but not from the app', async () => {
    const priya = await env.as('priya');
    for (const [method, path] of [['post', '/api/attendance/check-in'], ['post', '/api/attendance/break/start'], ['get', '/api/attendance/track'], ['get', '/api/attendance/presence']] as const) {
      const res = await (priya as any)[method](path).send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('USE_THE_APP');
    }
    const fromApp = await priya.get('/api/attendance/track').set('x-client', 'mobile');
    expect(fromApp.status).toBe(200);
  });

  it('leaves reading pages and HR screens on the web alone', async () => {
    const hr = await env.as('hema');
    expect((await hr.get('/api/attendance/today')).status).toBe(200);
    expect((await hr.get('/api/admin/tracking/live')).status).toBe(200);
  });
});
