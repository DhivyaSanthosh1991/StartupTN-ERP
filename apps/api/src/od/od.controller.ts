import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../common/auth.types';
import { todayIst } from '../common/dates';
import { dateStr, timeStr, uuid, zodPipe } from '../common/zod.pipe';
import { OdService } from './od.service';

const text = (max: number) => z.string().trim().max(max);

const odBody = z.object({
  kind: z.literal('od'),
  fromDate: dateStr,
  toDate: dateStr.optional(),
  location: text(200).optional(),
  purpose: text(500).min(3, 'Please say what the on-duty work is'),
});
const permissionBody = z.object({
  kind: z.literal('permission'),
  fromDate: dateStr,
  fromTime: timeStr,
  toTime: timeStr,
  purpose: text(500).min(3, 'Please give a short reason'),
});
const applyBody = z.discriminatedUnion('kind', [odBody, permissionBody]);

const listQuery = z.object({
  from: dateStr.optional(),
  to: dateStr.optional(),
  kind: z.enum(['od', 'permission']).optional(),
});
const teamQuery = listQuery.extend({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() });
const quotaQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM').optional() });
const idParam = z.object({ id: uuid });

@Controller('od')
export class OdController {
  constructor(private readonly od: OdService) {}

  @Post('requests')
  apply(@CurrentUser() user: AuthUser, @Body(zodPipe(applyBody)) body: z.infer<typeof applyBody>) {
    return this.od.apply(user, {
      kind: body.kind,
      fromDate: body.fromDate,
      toDate: body.kind === 'od' ? (body.toDate ?? body.fromDate) : body.fromDate,
      fromTime: body.kind === 'permission' ? body.fromTime : undefined,
      toTime: body.kind === 'permission' ? body.toTime : undefined,
      location: body.kind === 'od' ? body.location : undefined,
      purpose: body.purpose,
    });
  }

  @Get('requests')
  mine(@CurrentUser() user: AuthUser, @Query(zodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.od.mine(user, q);
  }

  // Must stay above ':id' so "team" is not read as an id.
  @Get('requests/team')
  team(@CurrentUser() user: AuthUser, @Query(zodPipe(teamQuery)) q: z.infer<typeof teamQuery>) {
    return this.od.team(user, q);
  }

  @Get('requests/:id')
  one(@CurrentUser() user: AuthUser, @Param(zodPipe(idParam)) p: z.infer<typeof idParam>) {
    return this.od.getForViewer(user, p.id);
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param(zodPipe(idParam)) p: z.infer<typeof idParam>) {
    return this.od.cancel(user, p.id);
  }

  @Get('permission-quota')
  quota(@CurrentUser() user: AuthUser, @Query(zodPipe(quotaQuery)) q: z.infer<typeof quotaQuery>) {
    return this.od.quota(user, q.month ?? todayIst().slice(0, 7));
  }
}
