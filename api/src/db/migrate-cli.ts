import { loadConfig } from '../config/config';
import { loadEnvFile } from '../config/env-file';
import { runMigrations } from './migrate';

loadEnvFile();
const config = loadConfig();
runMigrations(config.databaseUrl, console.log, config.databaseSsl).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
