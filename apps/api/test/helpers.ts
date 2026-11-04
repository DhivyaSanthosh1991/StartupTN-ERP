import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppConfig } from '../src/config/config';
import { Db } from '../src/db/db.service';
import { DemoIds, seedDemo } from '../src/db/seed';
import { SettingsService } from '../src/common/settings.service';
import { TEST_DATABASE_URL } from './global-setup';

export const testConfig: AppConfig = {
  nodeEnv: 'test',
  port: 0,
  databaseUrl: TEST_DATABASE_URL,
  databaseSsl: 'off',
  jwtSecret: 'test-secret-test-secret-test-secret',
  sessionHours: 1,
  googleClientId: 'test-client.apps.googleusercontent.com',
  allowedEmailDomain: 'startuptn.in',
  devLogin: true,
  storageDriver: 'local',
  s3Bucket: '',
  storageDir: join(tmpdir(), `startuptn-erp-test-uploads-${process.pid}`),
  awsRegion: 'ap-south-1',
  jobsToken: 'test-jobs-token-1234567890',
  webOrigin: 'http://localhost:3000',
  trustProxyHops: 1,
  biometricApiUrl: '',
  biometricApiUser: '',
  biometricApiPassword: '',
  biometricDeviceSerials: [],
  biometricLookbackDays: 2,
  emailDriver: 'log',
  emailFrom: 'ERP <no-reply@startuptn.in>',
};

export interface TestEnv {
  app: INestApplication;
  db: Db;
  ids: DemoIds;
  /** Signs in as a seeded employee (by first name, e.g. 'priya') and returns a supertest agent with the session. */
  as(email: string): Promise<request.Agent>;
  anon(): request.Agent;
  /** Wipes all business data and re-seeds the demo organisation. */
  reset(): Promise<DemoIds>;
  close(): Promise<void>;
}

export async function createTestEnv(overrides: Partial<AppConfig> = {}, customise?: (b: ReturnType<typeof Test.createTestingModule>) => void): Promise<TestEnv> {
  const config = { ...testConfig, ...overrides };
  const builder = Test.createTestingModule({ imports: [AppModule.register(config)] });
  customise?.(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  const db = app.get(Db);

  const env: TestEnv = {
    app,
    db,
    ids: undefined as unknown as DemoIds,
    async as(email: string) {
      const agent = request.agent(app.getHttpServer());
      const res = await agent.post('/api/auth/dev-login').send({ email: email.includes('@') ? email : `${email}@startuptn.in` });
      if (res.status !== 200) throw new Error(`dev login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
      return agent;
    },
    anon: () => request.agent(app.getHttpServer()),
    async reset() {
      await resetData(db);
      app.get(SettingsService).invalidate();
      env.ids = await db.tx((q) => seedDemo(q));
      return env.ids;
    },
    close: () => app.close(),
  };
  return env;
}

/** Deletes business data in dependency order and restores the default reference data (leave types, workflows, settings). */
export async function resetData(db: Db) {
  await db.query('truncate audit_log');
  for (const sql of [
    'delete from email_outbox',
    'delete from biometric_punches',
    'delete from biometric_imports',
    'delete from biometric_devices',
    'delete from documents',
    'delete from regularisation_requests',
    'delete from od_home_requests',
    'delete from od_requests',
    'delete from leave_requests',
    'delete from leave_ledger',
    'delete from approval_delegations',
    'delete from approval_steps',
    'delete from approval_requests',
    'delete from presence_checks',
    'delete from work_breaks',
    'delete from attendance_days',
    'delete from attendance_events',
    'delete from geofences',
    'delete from notices',
    'delete from holidays',
    'update approval_workflow_steps set approver_employee_id = null',
    'delete from employee_roles',
    'update departments set head_employee_id = null',
    'update employees set reporting_manager_id = null',
    'delete from employees',
    'delete from departments',
    'delete from approval_workflow_steps',
    'delete from approval_workflows',
    'delete from leave_types',
    'delete from org_settings',
  ]) {
    await db.query(sql);
  }
  // Put the default leave types, workflows and settings back, so a test that edits them cannot affect the next one.
  await db.query(readFileSync(join(__dirname, '../src/db/migrations/0002_reference_data.sql'), 'utf8'));
  // The product default is that check-in needs a selfie; most tests are about other rules, so they start with it off.
  await db.query(`insert into org_settings (key, value) values ('selfie_required', 'false')`);
}
