import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { EmployeesModule } from '../employees/employees.module';
import { LeaveController } from './leave.controller';
import { LeaveService } from './leave.service';

@Module({
  imports: [ApprovalsModule, EmployeesModule],
  controllers: [LeaveController],
  providers: [LeaveService],
  exports: [LeaveService],
})
export class LeaveModule {}
