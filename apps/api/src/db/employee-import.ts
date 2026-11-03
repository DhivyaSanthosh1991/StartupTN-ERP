import { Queryable } from './db.service';

/** One person from the staff list, cleaned up and ready to insert. */
export interface ImportedPerson {
  empCode: string;
  fullName: string;
  email: string;
  designation: string | null;
  department: string | null;
  joined: string | null;
  phone: string | null;
}

export interface ImportReport {
  people: ImportedPerson[];
  /** Rows left out, with the reason, so HR can decide what to do with them. */
  skipped: { row: number; name: string; why: string }[];
  /** Things changed or invented to make a row usable. HR should look at each. */
  notes: string[];
}

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** 03/09/2026 → 2026-09-03; anything that is not a real date → null. */
export function parseDmy(text: string): string | null {
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Reads the staff list (tab-separated, as copied from a spreadsheet, with a header row).
 * Columns are found by their heading, so their order does not matter:
 *   Emp ID, Name, Designation, Project Assigned, DOJ, Email ID, Contact Number
 */
export function readStaffList(text: string, opts: { domain: string; withPhones: boolean; today: string }): ImportReport {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const headerAt = lines.findIndex((l) => /emp\s*id/i.test(l) && /email/i.test(l));
  if (headerAt < 0) throw new Error('Could not find the heading row (it needs "Emp ID", "Name" and "Email ID" columns). Copy the list with its heading row.');
  const head = lines[headerAt].split('\t').map((h) => clean(h).toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const at = { id: col('emp id', 'employee id'), name: col('name', 'full name'), des: col('designation'), proj: col('project assigned', 'project', 'department'),
    doj: col('doj', 'date of joining'), mail: col('email id', 'email', 'official email'), tel: col('contact number', 'phone', 'mobile') };
  for (const k of ['id', 'name', 'mail'] as const) if (at[k] < 0) throw new Error(`The heading row has no ${k === 'id' ? 'Emp ID' : k === 'name' ? 'Name' : 'Email ID'} column`);

  const report: ImportReport = { people: [], skipped: [], notes: [] };
  const codes = new Map<string, string>();
  const emails = new Map<string, string>();
  let pending = 0;

  lines.slice(headerAt + 1).forEach((line, i) => {
    const row = headerAt + i + 2; // line number in the pasted list, counting the heading as 1
    if (!line.trim()) return;
    const f = line.split('\t');
    const get = (k: number) => (k >= 0 ? clean(f[k]) : '');
    const name = get(at.name);
    if (!name) { report.skipped.push({ row, name: '(no name)', why: 'no name' }); return; }

    let code = get(at.id).toUpperCase();
    let email = get(at.mail).toLowerCase();
    if (email.endsWith('@statuptn.in')) { // a typo in the source list
      report.notes.push(`${name}: email ${email} looked like a typo and was changed to ${email.replace('@statuptn.in', '@startuptn.in')}`);
      email = email.replace('@statuptn.in', '@startuptn.in');
    }

    if (code && codes.has(code)) {
      report.skipped.push({ row, name, why: `employee ID ${code} is already used by ${codes.get(code)}` });
      return;
    }
    if (email && emails.has(email)) {
      report.skipped.push({ row, name, why: `email ${email} is already used by ${emails.get(email)}` });
      return;
    }
    if (!code) {
      code = `PENDING-${String(++pending).padStart(2, '0')}`;
      report.notes.push(`${name}: no employee ID in the list, so the temporary code ${code} was used. Replace it in Employees.`);
    }
    if (!email) {
      email = `${code.toLowerCase()}@no-email.invalid`;
      report.notes.push(`${name} (${code}): no email in the list, so a placeholder was used and they cannot sign in until HR enters their real address.`);
    } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      report.skipped.push({ row, name, why: `"${email}" is not an email address` });
      return;
    } else if (!email.endsWith(`@${opts.domain}`)) {
      report.notes.push(`${name}: email ${email} is not on ${opts.domain}, so they cannot sign in with Google.`);
    }

    const designation = get(at.des) || null;
    const proj = get(at.proj);
    // The "project" column is used as the department, except where it only repeats the job title.
    const department = proj && !/^head$/i.test(proj) && !(designation && same(proj, designation)) ? proj : null;

    const dojText = get(at.doj);
    let joined = dojText ? parseDmy(dojText) : null;
    if (dojText && !joined) report.notes.push(`${name}: joining date "${dojText}" could not be read and was left blank.`);
    if (joined && joined > opts.today) {
      report.notes.push(`${name}: joining date ${joined} is in the future and was left blank.`);
      joined = null;
    }

    const phone = opts.withPhones ? get(at.tel).replace(/[^\d+]/g, '') || null : null;

    codes.set(code, name);
    emails.set(email, name);
    report.people.push({ empCode: code, fullName: name, email, designation, department, joined, phone });
  });
  return report;
}

export interface ImportOptions {
  adminEmails: string[];
  today: string;
  /**
   * Everyone reports to the chairman, so the chairman's office address is the one that approves.
   * The person whose designation is "Chairman" gets this address (and is created if the list has none),
   * and becomes the reporting manager of every other person.
   */
  approverEmail?: string;
}

/** Writes the cleaned list into the database and makes the given emails administrators. Runs inside the caller's transaction. */
export async function importStaff(q: Queryable, report: ImportReport, opts: ImportOptions): Promise<{ created: number; admins: string[]; addedAdmins: string[]; approver: string | null }> {
  const dept = new Map<string, string>();
  for (const name of new Set(report.people.map((p) => p.department).filter((d): d is string => !!d))) {
    dept.set(name, (await q.query('insert into departments (name) values ($1) returning id', [name])).rows[0].id as string);
  }
  const ids = new Map<string, string>(); // email → employee id
  for (const p of report.people) {
    const { rows } = await q.query(
      `insert into employees (emp_code, full_name, official_email, phone, designation, department_id, date_of_joining)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [p.empCode, p.fullName, p.email, p.phone, p.designation, p.department ? dept.get(p.department) : null, p.joined],
    );
    ids.set(p.email, rows[0].id as string);
  }

  const addedAdmins: string[] = [];
  for (const email of opts.adminEmails) {
    if (!ids.has(email)) {
      const { rows } = await q.query(
        `insert into employees (emp_code, full_name, official_email, designation, date_of_joining)
         values ($1,$2,$3,$4,$5) returning id`,
        [`ADMIN-${addedAdmins.length + 1}`, email.split('@')[0].toUpperCase() + ' (administrator account)', email, 'Administrator', opts.today],
      );
      ids.set(email, rows[0].id as string);
      addedAdmins.push(email);
    }
    await q.query(`insert into employee_roles (employee_id, role) values ($1,'hr_admin'),($1,'super_admin') on conflict do nothing`, [ids.get(email)]);
  }

  let approver: string | null = null;
  if (opts.approverEmail) {
    const email = opts.approverEmail.toLowerCase();
    const chair = report.people.find((p) => /^chairman$/i.test(p.designation ?? ''));
    let chairId: string;
    if (chair) {
      chairId = ids.get(chair.email)!;
      await q.query('update employees set official_email = $2 where id = $1', [chairId, email]);
    } else {
      chairId = (await q.query(
        `insert into employees (emp_code, full_name, official_email, designation, date_of_joining) values ('CHAIRMAN-OFFICE','Chairman''s office',$1,'Chairman',$2) returning id`,
        [email, opts.today])).rows[0].id as string;
    }
    await q.query('update employees set reporting_manager_id = $1 where id <> $1', [chairId]);
    approver = email;
  }

  // Without a start date, every working day before today would show as Absent.
  await q.query(
    `insert into org_settings (key, value) values ('attendance_start_date', to_jsonb($1::text))
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [opts.today],
  );
  await q.query(
    `insert into audit_log (actor_id, action, entity_type, entity_id, after_data) values (null, 'employee.import', 'employee', null, $1)`,
    [JSON.stringify({ created: report.people.length, skipped: report.skipped.length, admins: opts.adminEmails })],
  );
  return { created: report.people.length, admins: opts.adminEmails, addedAdmins, approver };
}
