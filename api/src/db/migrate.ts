import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { DatabaseSsl } from '../config/config';
import { poolSsl } from './db.service';

const MIGRATIONS_DIR = join(__dirname, 'migrations');
const LOCK_KEY = 726001; // arbitrary constant so two deploys never migrate at once

/** Applies every *.sql file in db/migrations that has not run yet, in name order. */
export async function runMigrations(databaseUrl: string, log: (m: string) => void = console.log, ssl: DatabaseSsl = 'off'): Promise<string[]> {
  const pool = new Pool({ connectionString: databaseUrl, ssl: poolSsl(ssl), max: 1 });
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);

    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
        log(`applied ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    if (!applied.length) log('database is up to date');
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}
