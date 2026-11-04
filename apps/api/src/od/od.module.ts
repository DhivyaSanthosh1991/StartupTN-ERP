import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { EmployeesModule } from '../employees/employees.module';
import { OdController } from './od.controller';
import { OdHomeService } from './od-home.service';
import { OdService } from './od.service';

@Module({
  imports: [ApprovalsModule, EmployeesModule],
  controllers: [OdController],
  providers: [OdService, OdHomeService],
  exports: [OdService],
})
export class OdModule {}
