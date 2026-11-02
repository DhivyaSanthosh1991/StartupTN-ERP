import { Queryable } from './db.service';

export type DemoIds = Record<
  'md' | 'opsHead' | 'manager' | 'priya' | 'ravi' | 'hr' | 'admin' | 'invHead' | 'analyst' |
  'deptOps' | 'deptInv' | 'deptHr' | 'office',
  string
>;

/**
 * A small fictional organisation for local development and the automated tests.
 * Every person here is made up. Replace with real data through the HR screens or an import.
 *
 *   md ── opsHead ── manager ── priya, ravi
 *    ├─── invHead ── analyst
 *    ├─── hr (HR admin)
 *    └─── admin (super admin)
 */
export async function seedDemo(q: Queryable): Promise<DemoIds> {
  const dept = async (name: string) =>
    (await q.query('insert into departments (name) values ($1) returning id', [name])).rows[0].id as string;
  const deptOps = await dept('Operations');
  const deptInv = await dept('Investments');
  const deptHr = await dept('Human Resources');

  const emp = async (
    code: string, name: string, designation: string, departmentId: string | null,
    managerId: string | null, joined: string, type = 'permanent',
  ) =>
    (await q.query(
      `insert into employees (emp_code, full_name, official_email, designation, department_id,
                              reporting_manager_id, date_of_joining, employment_type)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [code, name, `${name.split(' ')[0].toLowerCase()}@startuptn.in`, designation, departmentId, managerId, joined, type],
    )).rows[0].id as string;

  const md = await emp('E001', 'Meena Sundaram', 'Managing Director', null, null, '2020-04-01');
  const opsHead = await emp('E002', 'Hari Prasad', 'Head, Operations', deptOps, md, '2021-01-04');
  const manager = await emp('E003', 'Mani Kandan', 'Manager, Operations', deptOps, opsHead, '2021-06-14');
  const priya = await emp('E004', 'Priya Raman', 'Executive, Operations', deptOps, manager, '2022-03-07');
  const ravi = await emp('E005', 'Ravi Kumar', 'Executive, Operations', deptOps, manager, '2023-08-21');
  const hr = await emp('E006', 'Hema Lakshmi', 'HR Manager', deptHr, md, '2021-02-15');
  const admin = await emp('E007', 'Sathya Narayan', 'IT Administrator', null, md, '2021-09-01');
  const invHead = await emp('E008', 'Arun Vel', 'Head, Investments', deptInv, md, '2021-05-10');
  const analyst = await emp('E009', 'Divya Mohan', 'Analyst, Investments', deptInv, invHead, '2024-02-12');

  await q.query('update departments set head_employee_id = $2 where id = $1', [deptOps, opsHead]);
  await q.query('update departments set head_employee_id = $2 where id = $1', [deptInv, invHead]);
  await q.query('update departments set head_employee_id = $2 where id = $1', [deptHr, hr]);

  const role = (id: string, r: string) =>
    q.query('insert into employee_roles (employee_id, role) values ($1, $2)', [id, r]);
  await role(md, 'md');
  await role(opsHead, 'hod');
  await role(invHead, 'hod');
  await role(hr, 'hr_admin');
  await role(admin, 'super_admin');

  // Fixed-date national holidays only; movable festivals must be entered by HR.
  for (const [date, name] of [
    ['2026-12-25', 'Christmas Day'], ['2027-01-01', "New Year's Day"], ['2027-01-26', 'Republic Day'],
    ['2027-08-15', 'Independence Day'], ['2027-10-02', 'Gandhi Jayanti'],
  ]) {
    await q.query('insert into holidays (holiday_date, name) values ($1, $2)', [date, name]);
  }

  // Placeholder office fence in central Chennai — HR must replace with the real office coordinates.
  const office = (await q.query(
    `insert into geofences (name, kind, latitude, longitude, radius_m)
     values ('Demo office (replace with real location)', 'office', 13.0827, 80.2707, 150) returning id`,
  )).rows[0].id as string;

  await q.query(
    `insert into notices (title, body, created_by) values ($1, $2, $3)`,
    ['Welcome to the StartupTN staff portal',
     'Check in from the Attendance page, apply for leave, and track your approvals here.', hr],
  );

  return { md, opsHead, manager, priya, ravi, hr, admin, invHead, analyst, deptOps, deptInv, deptHr, office };
}
