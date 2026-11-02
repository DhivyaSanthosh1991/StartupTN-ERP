import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Loads KEY=value pairs from a .env file in the working directory or the repo root, without
 * overriding variables that are already set. A convenience for local development only —
 * on AWS the environment comes from the task definition and Secrets Manager.
 */
export function loadEnvFile() {
  for (const dir of [process.cwd(), join(process.cwd(), '../..')]) {
    const file = join(dir, '.env');
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
    return;
  }
}
