import { Pool } from 'pg';
import { loadConfig } from '../config/config';
import { loadEnvFile } from '../config/env-file';
import { poolSsl } from './db.service';
import { seedDemo } from './seed';

/** Loads the fictional demo organisation into an EMPTY database. Refuses to touch real data. */
async function main() {
  loadEnvFile();
  const config = loadConfig();
  if (config.nodeEnv === 'production') throw new Error('Refusing to load demo data in production');
  const pool = new Pool({ connectionString: config.databaseUrl, ssl: poolSsl(config.databaseSsl) });
  try {
    const { rows } = await pool.query('select count(*)::int as n from employees');
    if (rows[0].n > 0) {
      console.log('employees already exist — skipping demo seed');
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      await seedDemo(client);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
    console.log('demo organisation loaded. Sign in (dev login) as meena@startuptn.in, hema@startuptn.in, mani@startuptn.in, priya@startuptn.in ...');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
