import * as jwt from 'jsonwebtoken';
import { GoogleVerifier } from '../src/auth/google-verifier';
import { unauthorized } from '../src/common/errors';
import { TestEnv, createTestEnv, testConfig } from './helpers';

const identities: Record<string, any> = {
  'good-token-aaaaaaaaaaaaaaaa': { email: 'priya@startuptn.in', emailVerified: true, hostedDomain: 'startuptn.in' },
  'gmail-token-aaaaaaaaaaaaaaa': { email: 'priya@gmail.com', emailVerified: true },
  'spoof-token-aaaaaaaaaaaaaaa': { email: 'priya@startuptn.in', emailVerified: true, hostedDomain: 'other.org' },
  'unverified-token-aaaaaaaaaa': { email: 'priya@startuptn.in', emailVerified: false, hostedDomain: 'startuptn.in' },
  'stranger-token-aaaaaaaaaaaa': { email: 'nobody@startuptn.in', emailVerified: true, hostedDomain: 'startuptn.in' },
};

describe('authentication', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv({}, (b) =>
      b.overrideProvider(GoogleVerifier).useValue({
        verify: async (t: string) => {
          // Same behaviour as the real verifier: anything Google does not vouch for is a 401.
          if (!identities[t]) throw unauthorized('BAD_GOOGLE_TOKEN', 'Google sign-in could not be verified');
          return identities[t];
        },
      }),
    );
  });
  beforeEach(() => env.reset());
  afterAll(() => env.close());

  it('health check answers without a session', async () => {
    const res = await env.anon().get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('rejects requests with no session', async () => {
    const res = await env.anon().get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NO_SESSION');
  });

  it('exposes the sign-in configuration publicly', async () => {
    const res = await env.anon().get('/api/auth/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      googleClientId: testConfig.googleClientId,
      allowedDomain: 'startuptn.in',
      devLogin: true,
    });
  });

  it('dev login signs in a seeded employee and sets an httpOnly cookie', async () => {
    const agent = env.anon();
    const login = await agent.post('/api/auth/dev-login').send({ email: 'priya@startuptn.in' });
    expect(login.status).toBe(200);
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toContain('erp_session=');
    expect(cookie).toContain('HttpOnly');
    const me = await agent.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.fullName).toBe('Priya Raman');
    expect(me.body.reportingManagerName).toBe('Mani Kandan');
  });

  it('dev login refuses an email that is not in the employee master', async () => {
    const res = await env.anon().post('/api/auth/dev-login').send({ email: 'ghost@startuptn.in' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_REGISTERED');
  });

  it('dev login does not exist when switched off', async () => {
    const off = await createTestEnv({ devLogin: false });
    try {
      const res = await off.anon().post('/api/auth/dev-login').send({ email: 'priya@startuptn.in' });
      expect(res.status).toBe(404);
    } finally {
      await off.close();
    }
  });

  describe('Google sign-in', () => {
    const login = (idToken: string) => env.anon().post('/api/auth/google').send({ idToken });

    it('accepts a verified account on the company Workspace domain', async () => {
      const res = await login('good-token-aaaaaaaaaaaaaaaa');
      expect(res.status).toBe(200);
      expect(res.body.fullName).toBe('Priya Raman');
    });

    it('rejects a personal Gmail address', async () => {
      const res = await login('gmail-token-aaaaaaaaaaaaaaa');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('DOMAIN_NOT_ALLOWED');
    });

    it('rejects an address on our domain whose Google account belongs to another Workspace', async () => {
      const res = await login('spoof-token-aaaaaaaaaaaaaaa');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('DOMAIN_NOT_ALLOWED');
    });

    it('rejects an unverified email', async () => {
      const res = await login('unverified-token-aaaaaaaaaa');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('rejects a valid company account that HR has not added', async () => {
      const res = await login('stranger-token-aaaaaaaaaaaa');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_REGISTERED');
    });

    it('rejects a token Google does not recognise', async () => {
      const res = await login('forged-token-aaaaaaaaaaaaaaaa');
      expect(res.status).toBe(401);
    });
  });

  it('cuts off an employee the moment HR deactivates them, even with a live session', async () => {
    const priya = await env.as('priya');
    expect((await priya.get('/api/me')).status).toBe(200);

    const hr = await env.as('hema');
    const off = await hr.patch(`/api/employees/${env.ids.priya}`).send({ status: 'inactive' });
    expect(off.status).toBe(200);

    const after = await priya.get('/api/me');
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('ACCOUNT_INACTIVE');
  });

  it('rejects a session token that was signed with another secret or has expired', async () => {
    const forged = jwt.sign({}, 'some-other-secret-some-other-secret', { subject: env.ids.priya });
    const res = await env.anon().get('/api/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_EXPIRED');

    const expired = jwt.sign({}, testConfig.jwtSecret, { subject: env.ids.priya, expiresIn: -10 });
    const res2 = await env.anon().get('/api/me').set('Authorization', `Bearer ${expired}`);
    expect(res2.status).toBe(401);
  });

  it('logout clears the cookie', async () => {
    const res = await env.anon().post('/api/auth/logout');
    expect(res.status).toBe(204);
    expect(String(res.headers['set-cookie'])).toContain('erp_session=;');
  });
});
