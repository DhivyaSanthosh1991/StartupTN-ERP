import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { DocumentsModule } from '../documents/documents.module';
import { LeaveModule } from '../leave/leave.module';
import { JobsController } from './jobs.controller';

@Module({
  imports: [ApprovalsModule, LeaveModule, AttendanceModule, DocumentsModule],
  controllers: [JobsController],
})
export class JobsModule {}
