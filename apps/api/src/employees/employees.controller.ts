import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../common/auth.types';
import { dateStr, uuid, zodPipe } from '../common/zod.pipe';
import { EmployeesService } from './employees.service';

const employmentType = z.enum(['permanent', 'contract', 'consultant', 'intern']);

const createBody = z.object({
  empCode: z.string().trim().min(1).max(30),
  fullName: z.string().trim().min(1).max(120),
  officialEmail: z.string().trim().email(),
  phone: z.string().trim().max(20).nullish(),
  designation: z.string().trim().max(120).nullish(),
  departmentId: uuid.nullish(),
  employmentType: employmentType.optional(),
  dateOfJoining: dateStr.nullish(),
  dateOfBirth: dateStr.nullish(),
  gender: z.enum(['female', 'male', 'other']).nullish(),
  reportingManagerId: uuid.nullish(),
  attendanceMethod: z.enum(['selfie', 'biometric']).optional(),
  biometricCode: z.string().trim().max(40).nullish(),
});

const updateBody = createBody.partial().extend({
  status: z.enum(['active', 'inactive', 'exited']).optional(),
  exitDate: dateStr.nullish(),
});

const rolesBody = z.object({ roles: z.array(z.enum(['hod', 'md', 'hr_admin', 'finance', 'super_admin'])) });

const listQuery = z.object({
  search: z.string().optional(),
  status: z.enum(['active', 'inactive', 'exited']).optional(),
  departmentId: uuid.optional(),
});

@Controller()
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.employees.getProfile(user.id);
  }

  @Post('me/location-consent')
  @HttpCode(200)
  consent(@CurrentUser() user: AuthUser) {
    return this.employees.acceptLocationConsent(user);
  }

  @Post('me/photo-consent')
  @HttpCode(200)
  photoConsent(@CurrentUser() user: AuthUser) {
    return this.employees.acceptPhotoConsent(user);
  }

  @Get('me/team')
  team(@CurrentUser() user: AuthUser) {
    return this.employees.directReports(user.id);
  }

  @Get('employees/directory')
  directory(@Query('search') search?: string) {
    return this.employees.directory(search);
  }

  // The system administrator needs the list to assign roles.
  @Roles('hr_admin', 'super_admin')
  @Get('employees')
  list(@Query(zodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.employees.list(q);
  }

  @Roles('hr_admin')
  @Post('employees')
  create(@CurrentUser() user: AuthUser, @Body(zodPipe(createBody)) body: z.infer<typeof createBody>) {
    return this.employees.create(user, body);
  }

  @Get('employees/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', zodPipe(uuid)) id: string) {
    return this.employees.getForViewer(user, id);
  }

  @Roles('hr_admin')
  @Patch('employees/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', zodPipe(uuid)) id: string,
    @Body(zodPipe(updateBody)) body: z.infer<typeof updateBody>,
  ) {
    return this.employees.update(user, id, body);
  }

  @Roles('super_admin')
  @Put('employees/:id/roles')
  setRoles(
    @CurrentUser() user: AuthUser,
    @Param('id', zodPipe(uuid)) id: string,
    @Body(zodPipe(rolesBody)) body: z.infer<typeof rolesBody>,
  ) {
    return this.employees.setRoles(user, id, body.roles);
  }
}
