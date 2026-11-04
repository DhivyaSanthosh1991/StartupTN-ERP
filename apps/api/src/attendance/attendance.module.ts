import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { DocumentsModule } from '../documents/documents.module';
import { EmployeesModule } from '../employees/employees.module';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { BiometricService } from './biometric.service';
import { BreaksService } from './breaks.service';
import { PresenceService } from './presence.service';
import { RegularisationService } from './regularisation.service';

@Module({
  imports: [ApprovalsModule, EmployeesModule, DocumentsModule],
  controllers: [AttendanceController],
  providers: [AttendanceService, RegularisationService, BiometricService, BreaksService, PresenceService],
  exports: [AttendanceService, RegularisationService, BiometricService],
})
export class AttendanceModule {}
