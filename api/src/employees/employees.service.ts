import { Injectable } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { AuthUser, Role, hasRole } from '../common/auth.types';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { Db, Queryable } from '../db/db.service';

export interface EmployeeInput {
  empCode: string;
  fullName: string;
  officialEmail: string;
  phone?: string | null;
  designation?: string | null;
  departmentId?: string | null;
  employmentType?: 'permanent' | 'contract' | 'consultant' | 'intern';
  dateOfJoining?: string | null;
  dateOfBirth?: string | null;
  reportingManagerId?: string | null;
  /** How attendance is taken: a selfie in the portal, or the biometric machine at head office. */
  attendanceMethod?: 'selfie' | 'biometric';
  /** The person's code on the biometric machine. */
  biometricCode?: string | null;
}

export interface EmployeeUpdate extends Partial<EmployeeInput> {
  status?: 'active' | 'inactive' | 'exited';
  exitDate?: string | null;
}

const COLUMN_FOR: Record<string, string> = {
  empCode: 'emp_code',
  fullName: 'full_name',
  officialEmail: 'official_email',
  phone: 'phone',
  designation: 'designation',
  departmentId: 'department_id',
  employmentType: 'employment_type',
  dateOfJoining: 'date_of_joining',
  dateOfBirth: 'date_of_birth',
  reportingManagerId: 'reporting_manager_id',
  attendanceMethod: 'attendance_method',
  biometricCode: 'biometric_code',
  status: 'status',
  exitDate: 'exit_date',
};

const PROFILE_SQL = `
  select e.id, e.emp_code, e.full_name, e.official_email, e.phone, e.designation, e.department_id,
         d.name as department_name, e.employment_type, e.date_of_joining, e.date_of_birth,
         e.reporting_manager_id, m.full_name as reporting_manager_name, e.status, e.exit_date,
         e.photo_url, e.location_consent_at, e.photo_consent_at, e.attendance_method, e.biometric_code,
         coalesce((select array_agg(role order by role) from employee_roles r where r.employee_id = e.id), '{}') as roles,
         (select count(*) from employees x where x.reporting_manager_id = e.id and x.status = 'active') as direct_reports
    from employees e
    left join departments d on d.id = e.department_id
    left join employees m on m.id = e.reporting_manager_id`;

@Injectable()
export class EmployeesService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private toProfile(r: any) {
    return {
      id: r.id,
      empCode: r.emp_code,
      fullName: r.full_name,
      officialEmail: r.official_email,
      phone: r.phone,
      designation: r.designation,
      departmentId: r.department_id,
      departmentName: r.department_name,
      employmentType: r.employment_type,
      dateOfJoining: r.date_of_joining,
      dateOfBirth: r.date_of_birth,
      reportingManagerId: r.reporting_manager_id,
      reportingManagerName: r.reporting_manager_name,
      status: r.status,
      exitDate: r.exit_date,
      photoUrl: r.photo_url,
      locationConsentAt: r.location_consent_at,
      photoConsentAt: r.photo_consent_at,
      attendanceMethod: r.attendance_method as 'selfie' | 'biometric',
      biometricCode: r.biometric_code as string | null,
      roles: r.roles as Role[],
      directReports: Number(r.direct_reports),
      isManager: Number(r.direct_reports) > 0,
    };
  }

  async getProfile(id: string) {
    const row = await this.db.one(`${PROFILE_SQL} where e.id = $1`, [id]);
    if (!row) throw notFound('EMPLOYEE_NOT_FOUND', 'Employee not found');
    return this.toProfile(row);
  }

  /** Full detail of one employee — only themself, HR, their reporting line, or their department head. */
  async getForViewer(viewer: AuthUser, id: string) {
    const profile = await this.getProfile(id);
    if (!(await this.canViewDetail(viewer, profile))) {
      throw forbidden('FORBIDDEN', 'You do not have access to this employee record');
    }
    return profile;
  }

  private async canViewDetail(viewer: AuthUser, target: { id: string; departmentId: string | null }) {
    if (viewer.id === target.id || hasRole(viewer, 'hr_admin')) return true;
    if (hasRole(viewer, 'hod') && target.departmentId && target.departmentId === viewer.departmentId) return true;
    return this.isInReportingLine(viewer.id, target.id);
  }

  /** True if `managerId` is anywhere above `employeeId` in the reporting chain. */
  async isInReportingLine(managerId: string, employeeId: string, q: Queryable = this.db): Promise<boolean> {
    const r = await q.query(
      `with recursive chain as (
         select reporting_manager_id as mgr from employees where id = $1
         union
         select e.reporting_manager_id from employees e join chain c on e.id = c.mgr where c.mgr is not null
       ) select 1 from chain where mgr = $2 limit 1`,
      [employeeId, managerId],
    );
    return r.rowCount! > 0;
  }

  /**
   * Whose attendance and leave this person may see besides their own.
   * null means everyone (HR). Otherwise: everyone below them in the reporting line, plus — for
   * a head of department — the people in that department.
   */
  async teamScope(viewer: AuthUser): Promise<string[] | null> {
    if (hasRole(viewer, 'hr_admin')) return null;
    const rows = await this.db.rows(
      `with recursive sub as (
         select id from employees where reporting_manager_id = $1
         union
         select e.id from employees e join sub s on e.reporting_manager_id = s.id
       ) select id from sub`,
      [viewer.id],
    );
    const ids = new Set<string>(rows.map((r) => r.id));
    if (hasRole(viewer, 'hod') && viewer.departmentId) {
      const dept = await this.db.rows('select id from employees where department_id = $1', [viewer.departmentId]);
      for (const d of dept) ids.add(d.id);
    }
    ids.delete(viewer.id);
    return [...ids];
  }

  /** Active employees with the fields everyone may see. */
  async directory(search?: string) {
    const rows = await this.db.rows(
      `select e.id, e.emp_code, e.full_name, e.official_email, e.designation, e.department_id,
              d.name as department_name, e.reporting_manager_id, e.photo_url
         from employees e left join departments d on d.id = e.department_id
        where e.status = 'active'
          and ($1::text is null or e.full_name ilike '%' || $1 || '%' or e.emp_code ilike '%' || $1 || '%'
               or e.designation ilike '%' || $1 || '%')
        order by e.full_name`,
      [search?.trim() || null],
    );
    return rows.map((r) => ({
      id: r.id,
      empCode: r.emp_code,
      fullName: r.full_name,
      officialEmail: r.official_email,
      designation: r.designation,
      departmentId: r.department_id,
      departmentName: r.department_name,
      reportingManagerId: r.reporting_manager_id,
      photoUrl: r.photo_url,
    }));
  }

  /** HR view: every employee, any status. */
  async list(filter: { search?: string; status?: string; departmentId?: string }) {
    const rows = await this.db.rows(
      `${PROFILE_SQL}
        where ($1::text is null or e.full_name ilike '%' || $1 || '%' or e.emp_code ilike '%' || $1 || '%'
               or e.official_email ilike '%' || $1 || '%')
          and ($2::text is null or e.status = $2)
          and ($3::uuid is null or e.department_id = $3)
        order by e.emp_code`,
      [filter.search?.trim() || null, filter.status ?? null, filter.departmentId ?? null],
    );
    return rows.map((r) => this.toProfile(r));
  }

  /** People who report directly to this employee. */
  async directReports(managerId: string) {
    const rows = await this.db.rows(
      `select id, emp_code, full_name, designation from employees
        where reporting_manager_id = $1 and status = 'active' order by full_name`,
      [managerId],
    );
    return rows.map((r) => ({ id: r.id, empCode: r.emp_code, fullName: r.full_name, designation: r.designation }));
  }

  async create(actor: AuthUser, input: EmployeeInput) {
    await this.assertManagerValid(input.reportingManagerId ?? null, null);
    if (input.attendanceMethod === 'biometric' && !input.biometricCode?.trim()) {
      throw badRequest('BIOMETRIC_CODE_REQUIRED', 'Enter this person\'s code on the biometric machine before choosing the biometric machine');
    }
    try {
      const row = await this.db.tx(async (q) => {
        const r = await q.query(
          `insert into employees (emp_code, full_name, official_email, phone, designation, department_id,
                                  employment_type, date_of_joining, date_of_birth, reporting_manager_id,
                                  attendance_method, biometric_code)
           values ($1,$2,$3,$4,$5,$6,coalesce($7,'permanent'),$8,$9,$10,coalesce($11,'selfie'),$12) returning id`,
          [
            input.empCode.trim(),
            input.fullName.trim(),
            input.officialEmail.trim().toLowerCase(),
            input.phone ?? null,
            input.designation ?? null,
            input.departmentId ?? null,
            input.employmentType ?? null,
            input.dateOfJoining ?? null,
            input.dateOfBirth ?? null,
            input.reportingManagerId ?? null,
            input.attendanceMethod ?? null,
            input.biometricCode?.trim() || null,
          ],
        );
        await this.audit.record(
          { actorId: actor.id, action: 'employee.create', entityType: 'employee', entityId: r.rows[0].id,
            after: { ...input, officialEmail: input.officialEmail.toLowerCase() } },
          q,
        );
        return r.rows[0];
      });
      return this.getProfile(row.id);
    } catch (err) {
      throw this.translateUnique(err);
    }
  }

  async update(actor: AuthUser, id: string, patch: EmployeeUpdate) {
    const before = await this.getProfile(id);

    if (patch.reportingManagerId !== undefined) {
      await this.assertManagerValid(patch.reportingManagerId, id);
    }
    if (patch.status && patch.status !== 'active' && id === actor.id) {
      throw badRequest('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account');
    }

    if (typeof patch.biometricCode === 'string') patch = { ...patch, biometricCode: patch.biometricCode.trim() || null };
    const nextMethod = patch.attendanceMethod ?? before.attendanceMethod;
    const nextCode = patch.biometricCode === undefined ? before.biometricCode : patch.biometricCode;
    if (nextMethod === 'biometric' && !nextCode) {
      throw badRequest('BIOMETRIC_CODE_REQUIRED', 'Enter this person\'s code on the biometric machine before choosing the biometric machine');
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, col] of Object.entries(COLUMN_FOR)) {
      const v = (patch as Record<string, unknown>)[key];
      if (v === undefined) continue;
      values.push(key === 'officialEmail' && typeof v === 'string' ? v.trim().toLowerCase() : v);
      sets.push(`${col} = $${values.length}`);
    }
    if (!sets.length) return before;
    if (patch.status === 'exited' && patch.exitDate === undefined) {
      values.push(new Date().toISOString().slice(0, 10));
      sets.push(`exit_date = $${values.length}`);
    }
    values.push(id);

    try {
      await this.db.tx(async (q) => {
        await q.query(`update employees set ${sets.join(', ')}, updated_at = now() where id = $${values.length}`, values);
        await this.audit.record(
          { actorId: actor.id, action: 'employee.update', entityType: 'employee', entityId: id, before: pick(before, patch), after: patch },
          q,
        );
      });
    } catch (err) {
      throw this.translateUnique(err);
    }
    return this.getProfile(id);
  }

  async setRoles(actor: AuthUser, id: string, roles: Role[]) {
    const before = await this.getProfile(id);
    if (id === actor.id && before.roles.includes('super_admin') && !roles.includes('super_admin')) {
      throw badRequest('CANNOT_REMOVE_OWN_SUPER_ADMIN', 'You cannot remove your own super admin role');
    }
    await this.db.tx(async (q) => {
      await q.query('delete from employee_roles where employee_id = $1', [id]);
      for (const role of new Set(roles)) {
        await q.query('insert into employee_roles (employee_id, role) values ($1, $2)', [id, role]);
      }
      await this.audit.record(
        { actorId: actor.id, action: 'employee.set_roles', entityType: 'employee', entityId: id, before: before.roles, after: roles },
        q,
      );
    });
    return this.getProfile(id);
  }

  async acceptLocationConsent(user: AuthUser) {
    await this.db.tx(async (q) => {
      await q.query('update employees set location_consent_at = coalesce(location_consent_at, now()) where id = $1', [user.id]);
      await this.audit.record({ actorId: user.id, action: 'employee.location_consent', entityType: 'employee', entityId: user.id }, q);
    });
    return this.getProfile(user.id);
  }

  async acceptPhotoConsent(user: AuthUser) {
    await this.db.tx(async (q) => {
      await q.query('update employees set photo_consent_at = coalesce(photo_consent_at, now()) where id = $1', [user.id]);
      await this.audit.record({ actorId: user.id, action: 'employee.photo_consent', entityType: 'employee', entityId: user.id }, q);
    });
    return this.getProfile(user.id);
  }

  /** A manager must exist, be active, and must not sit below the employee (no reporting loops). */
  private async assertManagerValid(managerId: string | null, employeeId: string | null) {
    if (!managerId) return;
    const mgr = await this.db.one('select status from employees where id = $1', [managerId]);
    if (!mgr) throw badRequest('MANAGER_NOT_FOUND', 'The reporting manager does not exist');
    if (mgr.status !== 'active') throw badRequest('MANAGER_INACTIVE', 'The reporting manager is not an active employee');
    if (employeeId) {
      if (managerId === employeeId) throw badRequest('MANAGER_LOOP', 'An employee cannot report to themself');
      if (await this.isInReportingLine(employeeId, managerId)) {
        throw badRequest('MANAGER_LOOP', 'That would create a reporting loop');
      }
    }
  }

  private translateUnique(err: any) {
    if (err?.code === '23505') {
      if (String(err.constraint).includes('email')) return conflict('EMAIL_TAKEN', 'An employee with this email already exists');
      if (String(err.constraint).includes('biometric')) return conflict('BIOMETRIC_CODE_TAKEN', 'Another employee already has this biometric code');
      return conflict('EMP_CODE_TAKEN', 'An employee with this code already exists');
    }
    if (err?.code === '23503') return badRequest('BAD_REFERENCE', 'A department or manager reference does not exist');
    return err;
  }
}

function pick(obj: Record<string, any>, keys: object) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(keys)) out[k] = obj[k];
  return out;
}
