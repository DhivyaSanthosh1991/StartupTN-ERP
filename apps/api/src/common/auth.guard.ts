import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { AppConfig, CONFIG } from '../config/config';
import { Db } from '../db/db.service';
import { AuthUser, IS_PUBLIC, ROLES_KEY, Role, SESSION_COOKIE } from './auth.types';
import { forbidden, unauthorized } from './errors';

/**
 * Global guard: every route needs a valid session unless marked @Public().
 * The employee and their roles are re-read from the database on each request, so
 * deactivating an employee or removing a role takes effect immediately.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    const token: string | undefined =
      req.cookies?.[SESSION_COOKIE] ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!token) throw unauthorized('NO_SESSION', 'Please sign in');

    let sub: string;
    try {
      const payload = jwt.verify(token, this.config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      sub = String(payload.sub);
    } catch {
      throw unauthorized('SESSION_EXPIRED', 'Your session has expired. Please sign in again');
    }

    const row = await this.db.one(
      `select e.id, e.emp_code, e.full_name, e.official_email, e.department_id, e.reporting_manager_id, e.status,
              coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles
         from employees e
         left join employee_roles r on r.employee_id = e.id
        where e.id = $1
        group by e.id`,
      [sub],
    );
    if (!row || row.status !== 'active') {
      throw unauthorized('ACCOUNT_INACTIVE', 'This account is no longer active');
    }

    const user: AuthUser = {
      id: row.id,
      empCode: row.emp_code,
      fullName: row.full_name,
      email: row.official_email,
      roles: row.roles as Role[],
      departmentId: row.department_id,
      reportingManagerId: row.reporting_manager_id,
    };
    req.user = user;

    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);
    if (required?.length && !required.some((r) => user.roles.includes(r))) {
      throw forbidden('FORBIDDEN', 'You do not have access to this');
    }
    return true;
  }
}
