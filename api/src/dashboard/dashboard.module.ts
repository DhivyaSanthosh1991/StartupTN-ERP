import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { DocumentsModule } from '../documents/documents.module';
import { LeaveModule } from '../leave/leave.module';
import { OrgModule } from '../org/org.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [ApprovalsModule, AttendanceModule, DocumentsModule, LeaveModule, OrgModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
