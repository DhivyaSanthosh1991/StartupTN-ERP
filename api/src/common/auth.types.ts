import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';

export type Role = 'hod' | 'md' | 'hr_admin' | 'finance' | 'super_admin';

export interface AuthUser {
  id: string;
  empCode: string;
  fullName: string;
  email: string;
  roles: Role[];
  departmentId: string | null;
  reportingManagerId: string | null;
}

export const SESSION_COOKIE = 'erp_session';

export const IS_PUBLIC = 'isPublic';
export const ROLES_KEY = 'roles';

/** Route needs no sign-in. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route needs one of these elevated roles (anyone signed in is an employee). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

export const hasRole = (user: AuthUser, ...roles: Role[]) => roles.some((r) => user.roles.includes(r));
