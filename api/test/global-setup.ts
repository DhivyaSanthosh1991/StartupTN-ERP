import { runMigrations } from '../src/db/migrate';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/erp_test';

/** Brings the throw-away test database up to the current schema before any spec runs. */
export default async function globalSetup() {
  await runMigrations(TEST_DATABASE_URL, () => undefined);
}
