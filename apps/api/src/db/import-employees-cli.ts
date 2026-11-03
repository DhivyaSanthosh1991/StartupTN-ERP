import { readFileSync } from 'fs';
import { Pool } from 'pg';
import { loadConfig } from '../config/config';
import { loadEnvFile } from '../config/env-file';
import { poolSsl } from './db.service';
import { importStaff, readStaffList } from './employee-import';

/**
 * Replaces the fictional demo staff with the real staff list.
 *   npx tsx src/db/import-employees-cli.ts <staff-list.txt> [--admin a@x.in,b@x.in] [--approver chairmanoffice@x.in] [--with-phones] [--check]
 * The list is a tab-separated copy of the spreadsheet, with its heading row. It stays on your computer: do not
 * add it to the repository, because it holds personal details.
 *   --check        only reads the list and prints what would happen; changes nothing
 *   --with-phones  also stores phone numbers (left out by default)
 * The demo data is removed only if every person in the database is one of the nine demo people. Once real
 * people exist, this command refuses, so it cannot wipe live records.
 */
const DEMO_CODES = ['E001', 'E002', 'E003', 'E004', 'E005', 'E006', 'E007', 'E008', 'E009'];

/** The standard approver chains (the same ones migration 0002 creates). Safe to run again. */
const DEFAULT_FLOWS = `
  insert into approval_workflows (request_type, name) values
    ('leave','Leave approval'),('od','On-duty approval'),('permission','Permission approval'),('regularisation','Attendance regularisation approval')
  on conflict (request_type) do nothing;
  insert into approval_workflow_steps (workflow_id, step_order, approver_kind, min_days, sla_hours)
    select w.id, 1, 'reporting_manager', null, 48 from approval_workflows w where w.request_type in ('leave','od','permission','regularisation')
  on conflict (workflow_id, step_order) do nothing;
  insert into approval_workflow_steps (workflow_id, step_order, approver_kind, min_days, sla_hours)
    select w.id, 2, 'department_head', 5, 48 from approval_workflows w where w.request_type = 'leave'
  on conflict (workflow_id, step_order) do nothing;`;

const flag = (name: string) => process.argv.includes(`--${name}`);
const value = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main() {
  loadEnvFile();
  if (flag('repair-flows')) {
    // For a database where an earlier version of this command removed the approver chains.
    const config = loadConfig();
    const pool = new Pool({ connectionString: config.databaseUrl, ssl: poolSsl(config.databaseSsl) });
    try {
      await pool.query(DEFAULT_FLOWS);
      const n = (await pool.query('select count(*)::int as n from approval_workflow_steps')).rows[0].n;
      console.log(`Approver chains restored (${n} steps). Nothing else was changed.`);
    } finally {
      await pool.end();
    }
    return;
  }
  const file = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== value('admin') && a !== value('approver'));
  if (!file) throw new Error('Usage: import-employees-cli <staff-list.txt> [--admin a@x.in,b@x.in] [--approver x@y.in] [--with-phones] [--check]');
  const config = loadConfig();
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10); // India date
  const report = readStaffList(readFileSync(file, 'utf8'), { domain: config.allowedEmailDomain, withPhones: flag('with-phones'), today });
  const admins = (value('admin') ?? 'hr@startuptn.in,dhivya@startuptn.in').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

  console.log(`Read ${report.people.length} people from the list.`);
  if (report.skipped.length) {
    console.log(`\nLeft out (${report.skipped.length}):`);
    for (const s of report.skipped) console.log(`  line ${s.row}: ${s.name}: ${s.why}`);
  }
  if (report.notes.length) {
    console.log(`\nPlease check (${report.notes.length}):`);
    for (const n of report.notes) console.log(`  ${n}`);
  }
  const depts = new Set(report.people.map((p) => p.department).filter(Boolean));
  const approver = (value('approver') ?? 'chairmanoffice@startuptn.in').toLowerCase();
  console.log(`\nEveryone reports to the Chairman, whose sign-in address becomes ${approver}, so all approvals go there.`);
  console.log(`\n${depts.size} departments (taken from the Project Assigned column). Administrators: ${admins.join(', ')}`);
  if (flag('check')) { console.log('\n--check: nothing was changed.'); return; }

  const pool = new Pool({ connectionString: config.databaseUrl, ssl: poolSsl(config.databaseSsl) });
  const client = await pool.connect();
  try {
    const { rows } = await client.query('select emp_code from employees');
    const codes = rows.map((r) => r.emp_code as string);
    const real = codes.filter((c) => !DEMO_CODES.includes(c));
    if (real.length) throw new Error(`The database already holds real people (${real.slice(0, 3).join(', ')}...). This command only replaces the demo data, so nothing was changed.`);
    await client.query('begin');
    await client.query('truncate employees, departments, holidays, geofences, notices restart identity cascade');
    await client.query(DEFAULT_FLOWS); // the truncate also clears the approver chains, which belong to the system, not the demo
    const out = await importStaff(client, report, { adminEmails: admins, today, approverEmail: approver });
    await client.query('commit');
    console.log(`\nDone. ${out.created} people added. Administrators: ${out.admins.join(', ')}${out.addedAdmins.length ? ` (new accounts created for ${out.addedAdmins.join(', ')})` : ''}.`);
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
