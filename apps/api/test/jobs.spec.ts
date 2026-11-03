import { NotificationService } from '../src/common/notification.service';
import { TestEnv, createTestEnv, testConfig } from './helpers';

describe('scheduled jobs', () => {
  const routes = ['approval-escalations', 'emails', 'leave-accrual', 'attendance-nightly', 'documents-cleanup', 'selfie-cleanup', 'biometric-sync'];

  describe('with a token configured', () => {
    let env: TestEnv;
    beforeAll(async () => {
      env = await createTestEnv();
    });
    beforeEach(() => env.reset());
    afterAll(() => env.close());

    const call = (route: string, token?: string) => {
      const req = env.anon().post(`/api/jobs/${route}`);
      return token === undefined ? req : req.set('x-jobs-token', token);
    };

    it.each(routes)('%s refuses a missing or wrong token', async (route) => {
      expect((await call(route)).status).toBe(401);
      expect((await call(route, 'wrong')).status).toBe(401);
      expect((await call(route, testConfig.jobsToken + 'x')).status).toBe(401);
      expect((await call(route, testConfig.jobsToken.slice(0, -1))).body.code).toBe('BAD_JOBS_TOKEN');
    });

    it.each(routes)('%s is not opened by a signed-in session alone', async (route) => {
      const hr = await env.as('hema');
      expect((await hr.post(`/api/jobs/${route}`)).status).toBe(401);
    });

    it('runs each job with the right token', async () => {
      const t = testConfig.jobsToken;
      expect((await call('approval-escalations', t)).body).toEqual({ reminded: 0, escalated: 0 });
      expect((await call('leave-accrual', t)).body).toEqual({ employees: 9 });
      const nightly = await call('attendance-nightly', t);
      expect(nightly.status).toBe(200);
      expect(nightly.body).toMatchObject({ employees: 9, failed: 0 });
      expect((await call('documents-cleanup', t)).body).toEqual({ removed: 0 });
      expect((await call('selfie-cleanup', t)).body).toEqual({ removed: 0 });
      expect((await call('biometric-sync', t)).body).toMatchObject({ configured: false });
    });

    it('sends queued emails, once', async () => {
      const notify = env.app.get(NotificationService);
      await notify.queue({ to: 'a@startuptn.in', subject: 'One', text: 'x' });
      await notify.queue({ to: 'b@startuptn.in', subject: 'Two', text: 'x' });
      expect((await call('emails', testConfig.jobsToken)).body).toEqual({ sent: 2, failed: 0 });
      expect((await call('emails', testConfig.jobsToken)).body).toEqual({ sent: 0, failed: 0 });
      expect(await env.db.rows(`select 1 from email_outbox where status = 'sent'`)).toHaveLength(2);
    });
  });

  describe('with no token configured', () => {
    let env: TestEnv;
    beforeAll(async () => {
      env = await createTestEnv({ jobsToken: '' });
    });
    afterAll(() => env.close());

    it.each(routes)('%s does not exist, whatever is sent', async (route) => {
      expect((await env.anon().post(`/api/jobs/${route}`)).status).toBe(404);
      expect((await env.anon().post(`/api/jobs/${route}`).set('x-jobs-token', '')).status).toBe(404);
      expect((await env.anon().post(`/api/jobs/${route}`).set('x-jobs-token', 'anything')).status).toBe(404);
    });
  });
});
