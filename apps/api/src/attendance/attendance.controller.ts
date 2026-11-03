import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../common/auth.types';
import { todayIst } from '../common/dates';
import { badRequest } from '../common/errors';
import { dateStr, uuid, zodPipe } from '../common/zod.pipe';
import { AttendanceService } from './attendance.service';
import { BiometricService } from './biometric.service';
import { RegularisationService } from './regularisation.service';

const monthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');

const punchBody = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(1_000_000).optional(),
  note: z.string().trim().max(200).optional(),
  source: z.enum(['web', 'mobile']).default('web'),
  selfie: z.string().max(450_000).optional(),
});

const monthQuery = z.object({ month: monthStr.optional() });
const dayQuery = z.object({ date: dateStr.optional() });
const trailQuery = z.object({ employeeId: uuid.optional(), date: dateStr.optional() });
const idParam = z.object({ id: uuid });

const regBody = z.object({
  workDate: dateStr,
  checkInTime: timeStr.optional(),
  checkOutTime: timeStr.optional(),
  reason: z.string().trim().min(3, 'Please give a short reason').max(500),
});
const regTeamQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() });

const fenceBody = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['office', 'field']).default('office'),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusM: z.number().int().min(10).max(50_000),
  active: z.boolean().optional(),
});
const fencePatch = fenceBody.partial();

const exportQuery = z.object({ month: monthStr });
const biometricImportQuery = z.object({ serial: z.string().trim().max(60).optional() });
const rebuildBody = z.object({ from: dateStr, to: dateStr }).refine((b) => b.to >= b.from, 'to must not be before from');
const refreshBody = z.object({ from: dateStr, to: dateStr }).refine((b) => b.to >= b.from, 'to must not be before from');

@Controller()
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly regularisation: RegularisationService,
    private readonly biometric: BiometricService,
  ) {}

  // ------------------------------------------------------------------ punching

  @Get('attendance/today')
  today(@CurrentUser() user: AuthUser) {
    return this.attendance.today(user);
  }

  @Post('attendance/check-in')
  @HttpCode(200)
  checkIn(@CurrentUser() user: AuthUser, @Body(zodPipe(punchBody)) body: z.infer<typeof punchBody>) {
    return this.attendance.punch(user, 'check_in', body);
  }

  @Post('attendance/check-out')
  @HttpCode(200)
  checkOut(@CurrentUser() user: AuthUser, @Body(zodPipe(punchBody)) body: z.infer<typeof punchBody>) {
    return this.attendance.punch(user, 'check_out', body);
  }

  /** The photo taken at one punch (owner, reporting managers and HR only). */
  @Get('attendance/events/:id/selfie')
  async selfie(@CurrentUser() user: AuthUser, @Param(zodPipe(idParam)) p: z.infer<typeof idParam>, @Res({ passthrough: true }) res: any) {
    const photo = await this.attendance.selfie(user, p.id);
    res.set({ 'Content-Type': 'image/jpeg', 'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return new StreamableFile(photo);
  }

  @Get('attendance/geofences')
  geofences() {
    return this.attendance.geofences();
  }

  // --------------------------------------------------------------------- views

  @Get('attendance/me')
  me(@CurrentUser() user: AuthUser, @Query(zodPipe(monthQuery)) q: z.infer<typeof monthQuery>) {
    return this.attendance.monthFor(user, user.id, q.month ?? todayIst().slice(0, 7));
  }

  @Get('attendance/employees/:id')
  employee(
    @CurrentUser() user: AuthUser,
    @Param(zodPipe(idParam)) p: z.infer<typeof idParam>,
    @Query(zodPipe(monthQuery)) q: z.infer<typeof monthQuery>,
  ) {
    return this.attendance.monthFor(user, p.id, q.month ?? todayIst().slice(0, 7));
  }

  @Get('attendance/team/day')
  teamDay(@CurrentUser() user: AuthUser, @Query(zodPipe(dayQuery)) q: z.infer<typeof dayQuery>) {
    return this.attendance.teamDay(user, q.date ?? todayIst());
  }

  @Get('attendance/team/summary')
  teamSummary(@CurrentUser() user: AuthUser, @Query(zodPipe(monthQuery)) q: z.infer<typeof monthQuery>) {
    return this.attendance.teamSummary(user, q.month ?? todayIst().slice(0, 7));
  }

  @Get('attendance/trail')
  trail(@CurrentUser() user: AuthUser, @Query(zodPipe(trailQuery)) q: z.infer<typeof trailQuery>) {
    return this.attendance.trail(user, q.employeeId ?? user.id, q.date ?? todayIst());
  }

  // ------------------------------------------------------------ regularisation

  @Post('attendance/regularisations')
  apply(@CurrentUser() user: AuthUser, @Body(zodPipe(regBody)) body: z.infer<typeof regBody>) {
    return this.regularisation.apply(user, body);
  }

  @Get('attendance/regularisations')
  mine(@CurrentUser() user: AuthUser) {
    return this.regularisation.mine(user);
  }

  // Must stay above ':id' so "team" is not read as an id.
  @Get('attendance/regularisations/team')
  team(@CurrentUser() user: AuthUser, @Query(zodPipe(regTeamQuery)) q: z.infer<typeof regTeamQuery>) {
    return this.regularisation.team(user, q);
  }

  @Get('attendance/regularisations/:id')
  one(@CurrentUser() user: AuthUser, @Param(zodPipe(idParam)) p: z.infer<typeof idParam>) {
    return this.regularisation.getForViewer(user, p.id);
  }

  @Post('attendance/regularisations/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param(zodPipe(idParam)) p: z.infer<typeof idParam>) {
    return this.regularisation.cancel(user, p.id);
  }

  // --------------------------------------------------------------------- admin

  @Get('admin/geofences')
  @Roles('hr_admin')
  allGeofences() {
    return this.attendance.geofences(true);
  }

  @Post('admin/geofences')
  @Roles('hr_admin')
  createGeofence(@CurrentUser() user: AuthUser, @Body(zodPipe(fenceBody)) body: z.infer<typeof fenceBody>) {
    return this.attendance.createGeofence(user, body);
  }

  @Patch('admin/geofences/:id')
  @Roles('hr_admin')
  updateGeofence(
    @CurrentUser() user: AuthUser,
    @Param(zodPipe(idParam)) p: z.infer<typeof idParam>,
    @Body(zodPipe(fencePatch)) body: z.infer<typeof fencePatch>,
  ) {
    return this.attendance.updateGeofence(user, p.id, body);
  }

  @Get('admin/attendance/export')
  @Roles('hr_admin')
  async export(@Query(zodPipe(exportQuery)) q: z.infer<typeof exportQuery>, @Res({ passthrough: true }) res: any) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${q.month}.csv"`);
    return this.attendance.exportCsv(q.month);
  }

  /** Rebuilds the stored register for a date range, e.g. after holidays or settings were corrected. */
  @Post('admin/attendance/refresh')
  @Roles('hr_admin')
  @HttpCode(200)
  refresh(@Body(zodPipe(refreshBody)) body: z.infer<typeof refreshBody>) {
    return this.attendance.refreshAll(body.from, body.to);
  }

  // ---------------------------------------------------------------- biometric machine (head office)

  /** Machine connection, last pulls, recent imports and punch codes nobody owns yet. */
  @Get('admin/attendance/biometric')
  @Roles('hr_admin')
  biometricStatus() {
    return this.biometric.status();
  }

  /** An export from the machine's software, sent as plain text (CSV or the same rows the Web API returns). */
  @Post('admin/attendance/biometric/import')
  @Roles('hr_admin')
  @HttpCode(200)
  biometricImport(@CurrentUser() user: AuthUser, @Body() text: unknown, @Query(zodPipe(biometricImportQuery)) q: z.infer<typeof biometricImportQuery>) {
    if (typeof text !== 'string' || !text.trim()) {
      throw badRequest('EMPTY_IMPORT', 'The file is empty, or was not sent as plain text');
    }
    return this.biometric.importText(user, text, { source: 'file', serial: q.serial ?? null });
  }

  /** Pulls from the machine's Web API now, instead of waiting for the schedule. */
  @Post('admin/attendance/biometric/sync')
  @Roles('hr_admin')
  @HttpCode(200)
  biometricSync(@CurrentUser() user: AuthUser) {
    return this.biometric.sync(user);
  }

  /** Works a range of days out again from the stored punches. */
  @Post('admin/attendance/biometric/rebuild')
  @Roles('hr_admin')
  @HttpCode(200)
  biometricRebuild(@CurrentUser() user: AuthUser, @Body(zodPipe(rebuildBody)) body: z.infer<typeof rebuildBody>) {
    return this.biometric.rebuild(user, body.from, body.to);
  }
}
