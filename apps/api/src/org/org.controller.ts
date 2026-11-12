import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, Roles } from '../common/auth.types';
import { dateStr, timeStr, uuid, zodPipe } from '../common/zod.pipe';
import { OrgService } from './org.service';

const int = (min: number, max: number) => z.number().int().min(min).max(max);

const settingsBody = z
  .object({
    work_start: timeStr,
    grace_minutes: int(0, 120),
    full_day_minutes: int(60, 960),
    half_day_minutes: int(30, 600),
    weekly_off_days: z.array(int(0, 6)).max(3),
    leave_year_start_month: int(1, 12),
    leave_backdate_days: int(0, 90),
    regularisation_window_days: int(1, 90),
    permission_max_minutes: int(15, 480),
    permission_monthly_limit: int(0, 31),
    geofence_low_accuracy_m: int(10, 5000),
    attendance_start_date: dateStr.nullable(),
    selfie_required: z.boolean(),
    selfie_retention_days: int(7, 365),
    presence_checks_per_day: int(0, 6),
    presence_response_minutes: int(2, 60),
    presence_min_gap_minutes: int(15, 480),
    tracking_enabled: z.boolean(),
    tracking_interval_minutes: int(5, 30),
    tracking_away_grace_minutes: int(5, 120),
    tracking_retention_days: int(7, 90),
  })
  .partial()
  .strict();

const departmentBody = z.object({ name: z.string().trim().min(1).max(120), headEmployeeId: uuid.nullish() });
const departmentPatch = departmentBody.partial();
const holidayBody = z.object({ date: dateStr, name: z.string().trim().min(1).max(120), optional: z.boolean().optional() });
const noticeBody = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(5000),
  expiresOn: dateStr.nullish(),
});
const yearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });
const auditQuery = z.object({
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

@Controller()
export class OrgController {
  constructor(
    private readonly org: OrgService,
    private readonly audit: AuditService,
  ) {}

  @Get('departments')
  departments() {
    return this.org.departments();
  }

  @Roles('hr_admin')
  @Post('admin/departments')
  createDepartment(@CurrentUser() user: AuthUser, @Body(zodPipe(departmentBody)) body: z.infer<typeof departmentBody>) {
    return this.org.createDepartment(user, body);
  }

  @Roles('hr_admin')
  @Patch('admin/departments/:id')
  updateDepartment(
    @CurrentUser() user: AuthUser,
    @Param('id', zodPipe(uuid)) id: string,
    @Body(zodPipe(departmentPatch)) body: z.infer<typeof departmentPatch>,
  ) {
    return this.org.updateDepartment(user, id, body);
  }

  @Get('holidays')
  holidays(@Query(zodPipe(yearQuery)) q: z.infer<typeof yearQuery>) {
    return this.org.holidays(q.year);
  }

  @Roles('hr_admin')
  @Post('admin/holidays')
  addHoliday(@CurrentUser() user: AuthUser, @Body(zodPipe(holidayBody)) body: z.infer<typeof holidayBody>) {
    return this.org.addHoliday(user, body);
  }

  @Roles('hr_admin')
  @Delete('admin/holidays/:id')
  @HttpCode(204)
  deleteHoliday(@CurrentUser() user: AuthUser, @Param('id', zodPipe(uuid)) id: string) {
    return this.org.deleteHoliday(user, id);
  }

  @Get('notices')
  notices() {
    return this.org.notices();
  }

  @Roles('hr_admin')
  @Post('admin/notices')
  addNotice(@CurrentUser() user: AuthUser, @Body(zodPipe(noticeBody)) body: z.infer<typeof noticeBody>) {
    return this.org.addNotice(user, body);
  }

  @Roles('hr_admin')
  @Delete('admin/notices/:id')
  @HttpCode(204)
  deleteNotice(@CurrentUser() user: AuthUser, @Param('id', zodPipe(uuid)) id: string) {
    return this.org.deleteNotice(user, id);
  }

  @Roles('hr_admin')
  @Get('admin/settings')
  settings() {
    return this.org.getSettings();
  }

  @Roles('hr_admin')
  @Put('admin/settings')
  updateSettings(@CurrentUser() user: AuthUser, @Body(zodPipe(settingsBody)) body: z.infer<typeof settingsBody>) {
    return this.org.updateSettings(user, body);
  }

  @Roles('hr_admin', 'super_admin')
  @Get('admin/audit')
  auditLog(@Query(zodPipe(auditQuery)) q: z.infer<typeof auditQuery>) {
    return this.audit.list(q);
  }
}
