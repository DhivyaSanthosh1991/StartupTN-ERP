import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../common/auth.types';
import { dateStr, uuid, zodPipe } from '../common/zod.pipe';
import { DocumentsService } from './documents.service';

const createBody = z.object({
  employeeId: uuid.optional(),
  categoryCode: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(160),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().toLowerCase().max(120),
  sizeBytes: z.number().int().min(0).max(1_000_000_000),
  expiresOn: dateStr.nullish(),
  visibility: z.enum(['employee_and_hr', 'hr_only']).optional(),
});
const patchBody = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  expiresOn: dateStr.nullable().optional(),
  visibility: z.enum(['employee_and_hr', 'hr_only']).optional(),
});
const expiringQuery = z.object({ days: z.coerce.number().int().min(0).max(365).default(30) });
const idParam = z.object({ id: uuid });

@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('documents/categories')
  categories() {
    return this.documents.categories();
  }

  @Get('employees/:id/documents')
  list(@CurrentUser() user: AuthUser, @Param(zodPipe(idParam)) p: z.infer<typeof idParam>) {
    return this.documents.list(user, p.id);
  }

  // Declared before ':id' routes so "expiring" is not read as an id.
  @Get('documents/expiring')
  expiring(@CurrentUser() user: AuthUser, @Query(zodPipe(expiringQuery)) q: z.infer<typeof expiringQuery>) {
    return this.documents.expiring(user, q.days, false);
  }

  @Get('admin/documents/expiring')
  @Roles('hr_admin')
  expiringAll(@CurrentUser() user: AuthUser, @Query(zodPipe(expiringQuery)) q: z.infer<typeof expiringQuery>) {
    return this.documents.expiring(user, q.days, true);
  }

  @Post('documents')
  create(@CurrentUser() user: AuthUser, @Body(zodPipe(createBody)) body: z.infer<typeof createBody>) {
    return this.documents.create(user, body);
  }

  @Put('documents/:id/content')
  @HttpCode(204)
  async upload(@CurrentUser() user: AuthUser, @Param(zodPipe(idParam)) p: z.infer<typeof idParam>, @Req() req: any) {
    await this.documents.uploadLocal(user, p.id, req);
  }

  @Post('documents/:id/complete')
  @HttpCode(200)
  complete(@CurrentUser() user: AuthUser, @Param(zodPipe(idParam)) p: z.infer<typeof idParam>) {
    return this.documents.complete(user, p.id);
  }

  @Get('documents/:id/download-url')
  downloadUrl(@CurrentUser() user: AuthUser, @Param(zodPipe(idParam)) p: z.infer<typeof idParam>) {
    return this.documents.downloadUrl(user, p.id);
  }

  @Get('documents/:id/file')
  file(@CurrentUser() user: AuthUser, @Param(zodPipe(idParam)) p: z.infer<typeof idParam>) {
    return this.documents.streamLocal(user, p.id);
  }

  @Patch('documents/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param(zodPipe(idParam)) p: z.infer<typeof idParam>,
    @Body(zodPipe(patchBody)) body: z.infer<typeof patchBody>,
  ) {
    return this.documents.update(user, p.id, body);
  }

  @Delete('documents/:id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param(zodPipe(idParam)) p: z.infer<typeof idParam>) {
    await this.documents.remove(user, p.id);
  }
}
