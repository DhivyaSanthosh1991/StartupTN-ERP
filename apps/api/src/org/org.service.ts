import { Injectable } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth.types';
import { badRequest, conflict, notFound } from '../common/errors';
import { OrgSettings, SettingsService } from '../common/settings.service';
import { Db } from '../db/db.service';

@Injectable()
export class OrgService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  // ---------------------------------------------------------- departments

  async departments() {
    const rows = await this.db.rows(
      `select d.id, d.name, d.head_employee_id, h.full_name as head_name,
              (select count(*) from employees e where e.department_id = d.id and e.status = 'active') as headcount
         from departments d left join employees h on h.id = d.head_employee_id
        order by d.name`,
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, headEmployeeId: r.head_employee_id, headName: r.head_name, headcount: Number(r.headcount),
    }));
  }

  async createDepartment(actor: AuthUser, input: { name: string; headEmployeeId?: string | null }) {
    try {
      const row = await this.db.tx(async (q) => {
        const r = await q.query('insert into departments (name, head_employee_id) values ($1, $2) returning id',
          [input.name.trim(), input.headEmployeeId ?? null]);
        await this.audit.record({ actorId: actor.id, action: 'department.create', entityType: 'department', entityId: r.rows[0].id, after: input }, q);
        return r.rows[0];
      });
      return (await this.departments()).find((d) => d.id === row.id);
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('DEPARTMENT_EXISTS', 'A department with this name already exists');
      if (err?.code === '23503') throw badRequest('BAD_REFERENCE', 'The department head does not exist');
      throw err;
    }
  }

  async updateDepartment(actor: AuthUser, id: string, input: { name?: string; headEmployeeId?: string | null }) {
    const before = (await this.departments()).find((d) => d.id === id);
    if (!before) throw notFound('DEPARTMENT_NOT_FOUND', 'Department not found');
    try {
      await this.db.tx(async (q) => {
        await q.query(
          `update departments set name = coalesce($2, name),
             head_employee_id = case when $4 then $3 else head_employee_id end where id = $1`,
          [id, input.name?.trim() ?? null, input.headEmployeeId ?? null, input.headEmployeeId !== undefined],
        );
        await this.audit.record({ actorId: actor.id, action: 'department.update', entityType: 'department', entityId: id, before, after: input }, q);
      });
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('DEPARTMENT_EXISTS', 'A department with this name already exists');
      if (err?.code === '23503') throw badRequest('BAD_REFERENCE', 'The department head does not exist');
      throw err;
    }
    return (await this.departments()).find((d) => d.id === id);
  }

  // ------------------------------------------------------------- holidays

  holidays(year?: number) {
    return this.db.rows(
      `select id, holiday_date as date, name, optional from holidays
        where ($1::int is null or extract(year from holiday_date) = $1)
        order by holiday_date`,
      [year ?? null],
    );
  }

  async addHoliday(actor: AuthUser, input: { date: string; name: string; optional?: boolean }) {
    try {
      return await this.db.tx(async (q) => {
        const r = await q.query(
          'insert into holidays (holiday_date, name, optional) values ($1, $2, $3) returning id, holiday_date as date, name, optional',
          [input.date, input.name.trim(), input.optional ?? false],
        );
        await this.audit.record({ actorId: actor.id, action: 'holiday.create', entityType: 'holiday', entityId: r.rows[0].id, after: input }, q);
        return r.rows[0];
      });
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('HOLIDAY_EXISTS', 'A holiday is already set for that date');
      throw err;
    }
  }

  async deleteHoliday(actor: AuthUser, id: string) {
    await this.db.tx(async (q) => {
      const r = await q.query('delete from holidays where id = $1 returning holiday_date, name', [id]);
      if (!r.rowCount) throw notFound('HOLIDAY_NOT_FOUND', 'Holiday not found');
      await this.audit.record({ actorId: actor.id, action: 'holiday.delete', entityType: 'holiday', entityId: id, before: r.rows[0] }, q);
    });
  }

  // -------------------------------------------------------------- notices

  notices() {
    return this.db.rows(
      `select n.id, n.title, n.body, n.published_at, n.expires_on, a.full_name as author
         from notices n left join employees a on a.id = n.created_by
        where n.expires_on is null or n.expires_on >= (now() at time zone 'Asia/Kolkata')::date
        order by n.published_at desc limit 50`,
    );
  }

  async addNotice(actor: AuthUser, input: { title: string; body: string; expiresOn?: string | null }) {
    return this.db.tx(async (q) => {
      const r = await q.query(
        'insert into notices (title, body, expires_on, created_by) values ($1, $2, $3, $4) returning id, title, body, published_at, expires_on',
        [input.title.trim(), input.body.trim(), input.expiresOn ?? null, actor.id],
      );
      await this.audit.record({ actorId: actor.id, action: 'notice.create', entityType: 'notice', entityId: r.rows[0].id, after: input }, q);
      return r.rows[0];
    });
  }

  async deleteNotice(actor: AuthUser, id: string) {
    await this.db.tx(async (q) => {
      const r = await q.query('delete from notices where id = $1 returning title', [id]);
      if (!r.rowCount) throw notFound('NOTICE_NOT_FOUND', 'Notice not found');
      await this.audit.record({ actorId: actor.id, action: 'notice.delete', entityType: 'notice', entityId: id, before: r.rows[0] }, q);
    });
  }

  // ------------------------------------------------------------- settings

  getSettings() {
    return this.settings.get();
  }

  async updateSettings(actor: AuthUser, patch: Partial<OrgSettings>) {
    const before = await this.settings.get();
    const merged = { ...before, ...patch };
    if (merged.half_day_minutes > merged.full_day_minutes) {
      throw badRequest('BAD_SETTINGS', 'Half-day minutes cannot exceed full-day minutes');
    }
    await this.db.tx(async (q) => {
      for (const [key, value] of Object.entries(patch)) {
        await q.query(
          `insert into org_settings (key, value) values ($1, $2)
           on conflict (key) do update set value = excluded.value, updated_at = now()`,
          [key, JSON.stringify(value)],
        );
      }
      await this.audit.record({ actorId: actor.id, action: 'settings.update', entityType: 'settings', before, after: patch }, q);
    });
    this.settings.invalidate();
    return this.settings.get();
  }
}
