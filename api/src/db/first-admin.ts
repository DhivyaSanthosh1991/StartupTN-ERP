import { Queryable } from './db.service';

export interface FirstAdminInput {
  email: string;
  fullName: string;
  empCode: string;
  designation?: string;
}

/**
 * Creates the first person in an empty database, with the HR and system administrator roles.
 * Nobody can sign in until at least one employee exists, so this is how a new installation starts;
 * after that, HR adds everyone else from the Employees page.
 *
 * It refuses to run once any employee exists, so it cannot be used later to hand out admin rights.
 */
export async function createFirstAdmin(q: Queryable, input: FirstAdminInput, allowedDomain: string): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`"${input.email}" is not an email address`);
  if (!email.endsWith(`@${allowedDomain.toLowerCase()}`)) {
    throw new Error(`${email} is not on the ${allowedDomain} domain, so that person could not sign in`);
  }
  if (!input.fullName.trim()) throw new Error('A name is required');
  if (!input.empCode.trim()) throw new Error('An employee code is required');

  const existing = await q.query('select count(*)::int as n from employees');
  if (existing.rows[0].n > 0) {
    throw new Error('Employees already exist. Add people from the Employees page instead; this command only starts a new installation.');
  }

  const { rows } = await q.query(
    `insert into employees (emp_code, full_name, official_email, designation, date_of_joining)
     values ($1, $2, $3, $4, current_date) returning id`,
    [input.empCode.trim(), input.fullName.trim(), email, input.designation?.trim() || 'Administrator'],
  );
  const id = rows[0].id as string;
  await q.query(`insert into employee_roles (employee_id, role) values ($1, 'hr_admin'), ($1, 'super_admin')`, [id]);
  await q.query(
    `insert into audit_log (actor_id, action, entity_type, entity_id, after_data)
     values (null, 'employee.create_first_admin', 'employee', $1, $2)`,
    [id, JSON.stringify({ email, fullName: input.fullName.trim(), roles: ['hr_admin', 'super_admin'] })],
  );
  return id;
}
