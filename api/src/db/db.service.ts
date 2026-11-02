import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, QueryResult, QueryResultRow, types } from 'pg';
import { AppConfig, CONFIG, DatabaseSsl } from '../config/config';

// DATE and TIME stay as plain strings ('2026-11-02', '09:30:00') so they never shift with the
// server's time zone; NUMERIC and BIGINT come back as JS numbers (values here are small).
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1083, (v) => v);
types.setTypeParser(1700, (v) => parseFloat(v));
types.setTypeParser(20, (v) => parseInt(v, 10));

export interface Queryable {
  query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** The `ssl` option for a pg connection. Amazon RDS refuses unencrypted connections by default. */
export function poolSsl(mode: DatabaseSsl): { rejectUnauthorized: boolean } | undefined {
  if (mode === 'off') return undefined;
  return { rejectUnauthorized: mode === 'verify' };
}

@Injectable()
export class Db implements Queryable, OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl, ssl: poolSsl(config.databaseSsl), max: 10 });
  }

  query<T extends QueryResultRow = any>(text: string, params?: unknown[]) {
    return this.pool.query<T>(text, params as any[]);
  }

  async rows<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<T[]> {
    return (await this.pool.query<T>(text, params as any[])).rows;
  }

  async one<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<T | null> {
    const r = await this.pool.query<T>(text, params as any[]);
    return r.rows[0] ?? null;
  }

  /** Runs fn inside one transaction; rolls back if it throws. */
  async tx<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
