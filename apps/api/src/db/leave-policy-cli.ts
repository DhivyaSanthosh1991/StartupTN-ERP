import { Pool } from 'pg';
import { loadConfig } from '../config/config';
import { loadEnvFile } from '../config/env-file';
import { poolSsl } from './db.service';
import { applyLeavePolicy } from './leave-policy';

/**
 * Loads the StartupTN leave policy (casual leave, administrative staff leave, maternity, paternity).
 *   npx tsx src/db/leave-policy-cli.ts [--force]
 * Safe to run again.
 */
async function main() {
  loadEnvFile();
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, ssl: poolSsl(config.databaseSsl) });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await applyLeavePolicy(client, { force: process.argv.includes('--force') });
    await client.query('commit');
    console.log('Leave policy loaded. Leave years now run April to March.');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
