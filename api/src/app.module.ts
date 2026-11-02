import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApprovalsModule } from './approvals/approvals.module';
import { AttendanceModule } from './attendance/attendance.module';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './common/auth.guard';
import { CommonModule } from './common/common.module';
import { AppConfig } from './config/config';
import { DocumentsModule } from './documents/documents.module';
import { EmployeesModule } from './employees/employees.module';
import { HealthController } from './health.controller';
import { DashboardModule } from './dashboard/dashboard.module';
import { JobsModule } from './jobs/jobs.module';
import { LeaveModule } from './leave/leave.module';
import { OdModule } from './od/od.module';
import { OrgModule } from './org/org.module';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [CommonModule.register(config), AuthModule, EmployeesModule, OrgModule, ApprovalsModule, LeaveModule, OdModule, AttendanceModule, DocumentsModule, DashboardModule, JobsModule],
      controllers: [HealthController],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    };
  }
}
