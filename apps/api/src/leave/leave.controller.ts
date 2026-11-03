import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../common/auth.types';
import { dateStr, uuid, zodPipe } from '../common/zod.pipe';
import { LeaveService } from './leave.service';

const applyBody = z.object({
  leaveTypeId: uuid,
  fromDate: dateStr,
  toDate: dateStr,
  dayPart: z.enum(['full', 'first_half', 'second_half']).default('full'),
  reason: z.string().trim().min(3, 'Please give a short reason').max(1000),
});

const yearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });
const teamQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
});
const calendarQuery = z.object({ from: dateStr, to: dateStr }).refine((q) => q.to >= q.from, 'to must not be before from');
const idParam = z.object({ id: uuid });

const typeBody = z.object({
  code: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9_]+$/, 'Letters, digits and _ only'),
  name: z.string().trim().min(1).max(60),
  annualEntitlement: z.number().min(0).max(365),
  accrual: z.enum(['upfront', 'monthly', 'event']),
  carryForwardMax: z.number().min(0).max(365).default(0),
  allowHalfDay: z.boolean().default(true),
  paid: z.boolean().default(true),
  applicableEmploymentTypes: z.array(z.enum(['permanent', 'contract', 'consultant', 'intern'])).min(1),
  requiresDocumentAfterDays: z.number().min(0).max(365).nullish(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
const typePatch = typeBody.omit({ code: true }).partial();

const adjustBody = z.object({
  employeeId: uuid,
  leaveTypeId: uuid,
  year: z.number().int().min(2000).max(2100),
  days: z.number().min(-365).max(365).refine((n) => n !== 0, 'Days cannot be zero'),
  note: z.string().trim().min(3, 'A note is required for every adjustment').max(500),
});

@Controller()
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Get('leave/types')
  types(@CurrentUser() user: AuthUser) {
    return this.leave.typesFor(user.id);
  }

  @Get('leave/balances')
  balances(@CurrentUser() user: AuthUser, @Query(zodPipe(yearQuery)) q: z.infer<typeof yearQuery>) {
    return this.leave.balances(user.id, q.year);
  }

  @Get('leave/calendar')
  calendar(@CurrentUser() user: AuthUser, @Query(zodPipe(calendarQuery)) q: z.infer<typeof calendarQuery>) {
    return this.leave.calendar(user, q.from, q.to);
  }

  @Post('leave/requests')
  apply(@CurrentUser() user: AuthUser, @Body(zodPipe(applyBody)) body: z.infer<typeof applyBody>) {
    return this.leave.apply(user, body);
  }

  @Get('leave/requests')
  mine(@CurrentUser() user: AuthUser, @Query(zodPipe(yearQuery)) q: z.infer<typeof yearQuery>) {
    return this.leave.mine(user, q.year);
  }

  // Must stay above ':id' so "team" is not read as an id.
  @Get('leave/requests/team')
  team(@CurrentUser() user: AuthUser, @Query(zodPipe(teamQuery)) q: z.infer<typeof teamQuery>) {
    return this.leave.team(user, q);
  }

  @Get('leave/requests/:id')
  one(@CurrentUser() user: AuthUser, @Param(zodPipe(idParam)) p: z.infer<typeof idParam>) {
    return this.leave.getForViewer(user, p.id);
  }

  @Post('leave/requests/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param(zodPipe(idParam)) p: z.infer<typeof idParam>) {
    return this.leave.cancel(user, p.id);
  }

  /** A manager / HR looking at someone's balances; same access rule as their employee record. */
  @Get('employees/:id/leave-balances')
  balancesOf(
    @CurrentUser() user: AuthUser,
    @Param(zodPipe(idParam)) p: z.infer<typeof idParam>,
    @Query(zodPipe(yearQuery)) q: z.infer<typeof yearQuery>,
  ) {
    return this.leave.balancesForViewer(user, p.id, q.year);
  }

  // ------------------------------------------------------------------ admin

  @Get('admin/leave-types')
  @Roles('hr_admin')
  allTypes() {
    return this.leave.allTypes();
  }

  @Post('admin/leave-types')
  @Roles('hr_admin')
  createType(@CurrentUser() user: AuthUser, @Body(zodPipe(typeBody)) body: z.infer<typeof typeBody>) {
    return this.leave.createType(user, body);
  }

  @Patch('admin/leave-types/:id')
  @Roles('hr_admin')
  updateType(
    @CurrentUser() user: AuthUser,
    @Param(zodPipe(idParam)) p: z.infer<typeof idParam>,
    @Body(zodPipe(typePatch)) body: z.infer<typeof typePatch>,
  ) {
    return this.leave.updateType(user, p.id, body);
  }

  @Post('admin/leave-adjustments')
  @Roles('hr_admin')
  adjust(@CurrentUser() user: AuthUser, @Body(zodPipe(adjustBody)) body: z.infer<typeof adjustBody>) {
    return this.leave.adjust(user, body);
  }
}
