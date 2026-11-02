import { loadConfig } from '../src/config/config';

const base = {
  DATABASE_URL: 'postgres://localhost/erp',
  JWT_SECRET: 'a-long-enough-secret-value',
};
const production = {
  ...base,
  NODE_ENV: 'production',
  GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com',
  JOBS_TOKEN: 'a-real-jobs-token-123456',
  STORAGE_DRIVER: 's3',
  S3_BUCKET: 'erp-documents',
};

describe('configuration', () => {
  it('has safe development defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      nodeEnv: 'development', port: 4000, devLogin: false, storageDriver: 'local', storageDir: 'data/uploads',
      allowedEmailDomain: 'startuptn.in', emailDriver: 'log', jobsToken: '',
    });
  });

  it('connects to the database without TLS by default, and accepts the two TLS modes', () => {
    expect(loadConfig(base).databaseSsl).toBe('off');
    expect(loadConfig({ ...base, DATABASE_SSL: 'verify' }).databaseSsl).toBe('verify');
    expect(loadConfig({ ...base, DATABASE_SSL: 'no-verify' }).databaseSsl).toBe('no-verify');
    expect(() => loadConfig({ ...base, DATABASE_SSL: 'true' })).toThrow(/DATABASE_SSL/);
  });

  it('trusts one proxy by default and can be told about CloudFront in front of the load balancer', () => {
    expect(loadConfig(base).trustProxyHops).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY_HOPS: '2' }).trustProxyHops).toBe(2);
    expect(() => loadConfig({ ...base, TRUST_PROXY_HOPS: '-1' })).toThrow(/TRUST_PROXY_HOPS/);
  });

  it('turns dev login on only outside production, and only when asked', () => {
    expect(loadConfig({ ...base, AUTH_DEV_LOGIN: 'true' }).devLogin).toBe(true);
    expect(loadConfig({ ...base, AUTH_DEV_LOGIN: 'false' }).devLogin).toBe(false);
    expect(loadConfig({ ...production, AUTH_DEV_LOGIN: 'true' }).devLogin).toBe(false);
  });

  it('accepts a complete production setup', () => {
    expect(loadConfig(production)).toMatchObject({ nodeEnv: 'production', storageDriver: 's3', s3Bucket: 'erp-documents' });
  });

  it.each([
    ['a placeholder session secret', { JWT_SECRET: 'change-me-change-me-change-me' }, /JWT_SECRET/],
    ['no Google client id', { GOOGLE_CLIENT_ID: '' }, /GOOGLE_CLIENT_ID/],
    ['no jobs token', { JOBS_TOKEN: '' }, /JOBS_TOKEN/],
    ['a short jobs token', { JOBS_TOKEN: 'short' }, /JOBS_TOKEN/],
    ['a placeholder jobs token', { JOBS_TOKEN: 'change-me-change-me-please' }, /JOBS_TOKEN/],
    ['files kept on the container\'s disk', { STORAGE_DRIVER: 'local' }, /STORAGE_DRIVER must be s3/],
    ['S3 without a bucket', { S3_BUCKET: '' }, /S3_BUCKET/],
  ])('refuses to start in production with %s', (_label, change, message) => {
    expect(() => loadConfig({ ...production, ...change })).toThrow(message);
  });

  it('needs a bucket whenever S3 is chosen', () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
  });

  it('rejects missing or malformed required values, saying which', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 'ftp' })).toThrow(/STORAGE_DRIVER/);
  });

  it('is not connected to a biometric machine unless told where it is', () => {
    expect(loadConfig(base)).toMatchObject({ biometricApiUrl: '', biometricDeviceSerials: [], biometricLookbackDays: 2 });
  });

  it('reads the biometric machine settings, and needs all of them together', () => {
    const machine = {
      ...base, BIOMETRIC_API_URL: 'https://10.0.0.5/iclock/WebAPIService.asmx', BIOMETRIC_API_USER: 'api', BIOMETRIC_API_PASSWORD: 'secret',
      BIOMETRIC_DEVICE_SERIALS: ' BRM1, BRM2 ,', BIOMETRIC_LOOKBACK_DAYS: '5',
    };
    expect(loadConfig(machine)).toMatchObject({ biometricApiUrl: machine.BIOMETRIC_API_URL, biometricDeviceSerials: ['BRM1', 'BRM2'], biometricLookbackDays: 5 });
    expect(() => loadConfig({ ...machine, BIOMETRIC_API_USER: '' })).toThrow(/BIOMETRIC_API_USER/);
    expect(() => loadConfig({ ...machine, BIOMETRIC_API_PASSWORD: '' })).toThrow(/BIOMETRIC_API_PASSWORD/);
    expect(() => loadConfig({ ...machine, BIOMETRIC_DEVICE_SERIALS: '' })).toThrow(/BIOMETRIC_DEVICE_SERIALS/);
    expect(() => loadConfig({ ...machine, BIOMETRIC_API_URL: 'ftp://machine' })).toThrow(/http/);
    expect(() => loadConfig({ ...machine, BIOMETRIC_LOOKBACK_DAYS: '90' })).toThrow(/BIOMETRIC_LOOKBACK_DAYS/);
  });

  it('normalises the allowed email domain', () => {
    expect(loadConfig({ ...base, ALLOWED_EMAIL_DOMAIN: 'StartupTN.IN' }).allowedEmailDomain).toBe('startuptn.in');
  });
});

describe('database TLS option', () => {
  const { poolSsl } = jest.requireActual('../src/db/db.service');
  it('maps the setting onto the pg ssl option', () => {
    expect(poolSsl('off')).toBeUndefined();
    expect(poolSsl('verify')).toEqual({ rejectUnauthorized: true });
    expect(poolSsl('no-verify')).toEqual({ rejectUnauthorized: false });
  });
});
