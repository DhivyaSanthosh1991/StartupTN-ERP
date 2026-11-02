import { Pool } from 'pg';
import { loadConfig } from '../config/config';
import { loadEnvFile } from '../config/env-file';
import { poolSsl } from './db.service';
import { createFirstAdmin } from './first-admin';

/**
 * Starts a new installation: creates the first HR and system administrator.
 *   node dist/db/first-admin-cli.js --email hr@startuptn.in --name "Full Name" --code E001
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  loadEnvFile();
  const config = loadConfig();
  const email = arg('email');
  const name = arg('name');
  const code = arg('code');
  if (!email || !name || !code) {
    throw new Error('Usage: first-admin-cli --email <name@domain> --name "<full name>" --code <employee code> [--designation "<title>"]');
  }
  const pool = new Pool({ connectionString: config.databaseUrl, ssl: poolSsl(config.databaseSsl) });
  try {
    await createFirstAdmin(pool, { email, fullName: name, empCode: code, designation: arg('designation') }, config.allowedEmailDomain);
    console.log(`Created ${name} <${email.toLowerCase()}> with HR and system administrator roles. They can now sign in with Google.`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
