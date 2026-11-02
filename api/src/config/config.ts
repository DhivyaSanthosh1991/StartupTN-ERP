import { z } from 'zod';

export const CONFIG = Symbol('CONFIG');

export type DatabaseSsl = 'off' | 'verify' | 'no-verify';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  /** off: plain connection (local). verify: TLS, server certificate checked. no-verify: TLS, certificate not checked. */
  databaseSsl: DatabaseSsl;
  jwtSecret: string;
  sessionHours: number;
  googleClientId: string;
  allowedEmailDomain: string;
  devLogin: boolean;
  storageDriver: 'local' | 's3';
  s3Bucket: string;
  /** Where the local storage driver keeps files (development only). */
  storageDir: string;
  awsRegion: string;
  jobsToken: string;
  webOrigin: string;
  trustProxyHops: number;
  emailDriver: 'log' | 'ses';
  emailFrom: string;
  /** The biometric machine's Web API (eSSL eTimeTracklite). Empty URL means the portal is not connected to it. */
  biometricApiUrl: string;
  biometricApiUser: string;
  biometricApiPassword: string;
  /** Serial numbers of the machines to pull punches from. */
  biometricDeviceSerials: string[];
  /** How many days back each scheduled pull asks for, to catch punches the machine uploaded late. */
  biometricLookbackDays: number;
}

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(['off', 'verify', 'no-verify']).default('off'),
  JWT_SECRET: z.string().min(16),
  SESSION_HOURS: z.coerce.number().default(12),
  GOOGLE_CLIENT_ID: z.string().default(''),
  ALLOWED_EMAIL_DOMAIN: z.string().default('startuptn.in'),
  AUTH_DEV_LOGIN: z.string().default('false'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: z.string().default(''),
  LOCAL_STORAGE_DIR: z.string().default('data/uploads'),
  AWS_REGION: z.string().default('ap-south-1'),
  JOBS_TOKEN: z.string().default(''),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  EMAIL_DRIVER: z.enum(['log', 'ses']).default('log'),
  EMAIL_FROM: z.string().default('StartupTN ERP <no-reply@startuptn.in>'),
  BIOMETRIC_API_URL: z.string().default(''),
  BIOMETRIC_API_USER: z.string().default(''),
  BIOMETRIC_API_PASSWORD: z.string().default(''),
  BIOMETRIC_DEVICE_SERIALS: z.string().default(''),
  BIOMETRIC_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(31).default(2),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration — ${problems}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';

  if (production) {
    if (/change-me/i.test(e.JWT_SECRET)) throw new Error('JWT_SECRET must be set to a real secret in production');
    if (!e.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID is required in production');
    if (e.JOBS_TOKEN.length < 16 || /change-me/i.test(e.JOBS_TOKEN)) {
      throw new Error('JOBS_TOKEN must be set to a real secret in production');
    }
    if (e.STORAGE_DRIVER !== 's3') {
      throw new Error('STORAGE_DRIVER must be s3 in production: files on a container\'s own disk are lost on every deploy');
    }
    if (!e.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
  }
  if (e.STORAGE_DRIVER === 's3' && !e.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');

  const serials = e.BIOMETRIC_DEVICE_SERIALS.split(',').map((x) => x.trim()).filter(Boolean);
  if (e.BIOMETRIC_API_URL) {
    if (!/^https?:\/\/[^\s/]+/i.test(e.BIOMETRIC_API_URL)) throw new Error('BIOMETRIC_API_URL must start with http:// or https://');
    if (!e.BIOMETRIC_API_USER || !e.BIOMETRIC_API_PASSWORD) {
      throw new Error('BIOMETRIC_API_USER and BIOMETRIC_API_PASSWORD are required when BIOMETRIC_API_URL is set');
    }
    if (!serials.length) throw new Error('BIOMETRIC_DEVICE_SERIALS (comma-separated machine serial numbers) is required when BIOMETRIC_API_URL is set');
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    jwtSecret: e.JWT_SECRET,
    sessionHours: e.SESSION_HOURS,
    googleClientId: e.GOOGLE_CLIENT_ID,
    allowedEmailDomain: e.ALLOWED_EMAIL_DOMAIN.toLowerCase(),
    // Dev login can never be switched on in production, whatever the env says.
    devLogin: !production && e.AUTH_DEV_LOGIN === 'true',
    storageDriver: e.STORAGE_DRIVER,
    s3Bucket: e.S3_BUCKET,
    storageDir: e.LOCAL_STORAGE_DIR,
    awsRegion: e.AWS_REGION,
    jobsToken: e.JOBS_TOKEN,
    webOrigin: e.WEB_ORIGIN,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    emailDriver: e.EMAIL_DRIVER,
    emailFrom: e.EMAIL_FROM,
    biometricApiUrl: e.BIOMETRIC_API_URL,
    biometricApiUser: e.BIOMETRIC_API_USER,
    biometricApiPassword: e.BIOMETRIC_API_PASSWORD,
    biometricDeviceSerials: serials,
    biometricLookbackDays: e.BIOMETRIC_LOOKBACK_DAYS,
  };
}
