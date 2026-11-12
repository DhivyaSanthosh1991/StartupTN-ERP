'use strict';
// Copies punches from eTimeTrackLite (MS SQL Express) to the ERP. Run with --inspect first.
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    if (process.env[k] === undefined) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const env = process.env;
const STATE = path.join(__dirname, 'state.json');
const LOG = path.join(__dirname, 'bridge.log');
const BATCH = 2000;
const OVERLAP_MS = 60 * 60 * 1000;

function log(msg) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)}  ${msg}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1_000_000) fs.renameSync(LOG, LOG + '.old');
    fs.appendFileSync(LOG, line + '\n');
  } catch { /* logging must never stop the sync */ }
}

function need(name) {
  if (!env[name]) { log(`Missing ${name} in .env`); process.exit(2); }
  return env[name];
}

function sqlConfig() {
  const raw = need('SQL_SERVER');
  const [host, instance] = raw.split('\\');
  const cfg = {
    server: host,
    database: need('SQL_DATABASE'),
    user: need('SQL_USER'),
    password: need('SQL_PASSWORD'),
    options: { encrypt: false, trustServerCertificate: true, instanceName: instance || undefined },
    connectionTimeout: 15000,
    requestTimeout: 60000,
  };
  if (env.SQL_PORT) { cfg.port = Number(env.SQL_PORT); delete cfg.options.instanceName; }
  return cfg;
}

async function connect() {
  const sql = require('mssql');
  try {
    return { sql, pool: await sql.connect(sqlConfig()) };
  } catch (e) {
    log(`Could not connect to SQL Server: ${e.message}`);
    log('Check: SQL Server Browser service is running, TCP/IP is enabled for SQLEXPRESS (SQL Server Configuration Manager), the SQL login/password are right. Or set SQL_PORT in .env.');
    process.exit(3);
  }
}

async function logTables(pool) {
  const r = await pool.request().query(`
    select t.name as tbl, c.name as col, ty.name as typ
    from sys.tables t join sys.columns c on c.object_id = t.object_id join sys.types ty on ty.user_type_id = c.user_type_id
    where t.name like 'DeviceLogs%' order by t.name, c.column_id`);
  const tables = new Map();
  for (const row of r.recordset) {
    if (!tables.has(row.tbl)) tables.set(row.tbl, []);
    tables.get(row.tbl).push({ name: row.col, type: row.typ });
  }
  // only tables that look like punch logs: a user id and a log date
  return [...tables].filter(([, cols]) => {
    const n = cols.map((c) => c.name.toLowerCase());
    return n.includes('userid') && n.includes('logdate');
  }).map(([name, cols]) => ({ name, cols }));
}

async function inspect() {
  const { pool } = await connect();
  const dbs = await pool.request().query('select db_name() as db');
  log(`Connected. Database: ${dbs.recordset[0].db}`);
  const tables = await logTables(pool);
  if (!tables.length) {
    log('No DeviceLogs tables with UserId and LogDate found. Tables in this database:');
    const all = await pool.request().query('select name from sys.tables order by name');
    log(all.recordset.map((r) => r.name).join(', '));
    process.exit(0);
  }
  for (const t of tables) {
    const q = await pool.request().query(`select count(*) as n, min(LogDate) as first, max(LogDate) as last from [${t.name}]`);
    const { n, first, last } = q.recordset[0];
    log(`${t.name}: ${n} rows, ${first ? first.toISOString() : '-'} to ${last ? last.toISOString() : '-'}`);
    log(`  columns: ${t.cols.map((c) => `${c.name} (${c.type})`).join(', ')}`);
  }
  log('Inspect finished. Nothing was changed or sent.');
  await pool.close();
}

const pad = (n) => String(n).padStart(2, '0');
// mssql returns datetime as a Date built from the stored clock time in UTC, so read UTC parts to get the machine's clock time.
const stamp = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}

function post(body) {
  const base = need('ERP_URL').replace(/\/+$/, '');
  const url = new URL(`${base}/api/jobs/biometric-push${env.DEVICE_SERIAL ? `?serial=${encodeURIComponent(env.DEVICE_SERIAL)}` : ''}`);
  const lib = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'x-push-token': need('PUSH_TOKEN') },
      timeout: 90000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function postWithRetry(body) {
  // the free server may be asleep; the first request wakes it
  let last;
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await post(body);
      if (r.status === 200) return JSON.parse(r.data);
      if (r.status === 401) throw Object.assign(new Error('The ERP refused the token (PUSH_TOKEN does not match BIOMETRIC_PUSH_TOKEN on the server).'), { fatal: true });
      if (r.status === 404) throw Object.assign(new Error('The ERP has no BIOMETRIC_PUSH_TOKEN set (or it is shorter than 16 characters).'), { fatal: true });
      last = new Error(`ERP answered ${r.status}: ${r.data.slice(0, 200)}`);
    } catch (e) {
      if (e.fatal) throw e;
      last = e;
    }
    await new Promise((r) => setTimeout(r, i * 15000));
  }
  throw last;
}

async function sync() {
  const state = readState();
  const days = Number(env.FIRST_RUN_DAYS || 45);
  const since = state.watermark ? new Date(state.watermark - OVERLAP_MS) : new Date(Date.now() - days * 86400000);
  const { sql, pool } = await connect();
  const tables = await logTables(pool);
  if (!tables.length) { log('No DeviceLogs tables found. Run "node bridge.js --inspect".'); process.exit(4); }

  let newest = state.watermark || 0;
  let sent = 0;
  for (const t of tables) {
    const hasDir = t.cols.some((c) => c.name.toLowerCase() === 'direction');
    const dirCol = hasDir ? t.cols.find((c) => c.name.toLowerCase() === 'direction').name : null;
    // LogDate is the machine's clock stored as-is; compare with the same clock reading
    const sinceClock = new Date(Date.UTC(since.getFullYear(), since.getMonth(), since.getDate(), since.getHours(), since.getMinutes(), since.getSeconds()));
    const r = await pool.request().input('since', sql.DateTime, sinceClock)
      .query(`select UserId as code, LogDate as at${dirCol ? `, [${dirCol}] as dir` : ''} from [${t.name}] where LogDate >= @since order by LogDate`);
    const rows = r.recordset.filter((x) => x.code !== null && x.at);
    for (let i = 0; i < rows.length; i += BATCH) {
      const part = rows.slice(i, i + BATCH);
      const body = ['code,time,direction', ...part.map((x) => {
        const d = String(x.dir || '').toLowerCase();
        return `${String(x.code).trim()},${stamp(x.at)},${d === 'in' ? 'in' : d === 'out' ? 'out' : ''}`;
      })].join('\n');
      const res = await postWithRetry(body);
      sent += part.length;
      log(`${t.name}: sent ${part.length} — new ${res.inserted ?? '?'}, already there ${res.duplicates ?? '?'}, unknown codes ${res.unmatched ?? '?'}, rejected ${res.rejected ?? '?'}`);
    }
    for (const x of rows) {
      // back to a real instant for the watermark (reverse of the clock-as-UTC reading)
      const real = new Date(x.at.getUTCFullYear(), x.at.getUTCMonth(), x.at.getUTCDate(), x.at.getUTCHours(), x.at.getUTCMinutes(), x.at.getUTCSeconds()).getTime();
      if (real > newest) newest = real;
    }
  }
  await pool.close();
  if (newest) fs.writeFileSync(STATE, JSON.stringify({ watermark: newest, updated: new Date().toISOString() }));
  log(sent ? `Done. ${sent} punches read from the machine.` : 'Done. Nothing new.');
}

(async () => {
  try {
    if (process.argv.includes('--inspect')) await inspect(); else await sync();
  } catch (e) {
    log(`Failed: ${e.message}`);
    process.exit(1);
  }
})();
