import { timingSafeEqual } from 'crypto';
import { Body, Controller, Headers, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { ApprovalsService } from '../approvals/approvals.service';
import { AttendanceService } from '../attendance/attendance.service';
import { BiometricService } from '../attendance/biometric.service';
import { Public } from '../common/auth.types';
import { DocumentsService } from '../documents/documents.service';
import { badRequest, notFound, unauthorized } from '../common/errors';
import { NotificationService } from '../common/notification.service';
import { AppConfig, CONFIG } from '../config/config';
import { LeaveService } from '../leave/leave.service';

/**
 * Entry points for scheduled work (Amazon EventBridge calls these with a shared secret). They are
 * safe to run more often than needed: every job is idempotent.
 *
 *   approval-escalations   every 15 minutes   reminders, then escalation of unanswered approvals
 *   emails                 every minute       sends queued notification emails
 *   leave-accrual          daily              credits monthly leave and carries balances into a new year
 *   attendance-nightly     daily, after midnight   brings the attendance register up to date
 *   documents-cleanup      daily              clears uploads that were started but never finished
 *   biometric-sync         every 15 minutes   pulls the head-office machine's punches (does nothing until it is configured)

 *   biometric-push         from the biometric PC   receives punches read from the machine's database (own secret)
 *   selfie-cleanup         daily              deletes check-in photos older than the retention period
 */
@Controller('jobs')
export class JobsController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly approvals: ApprovalsService,
    private readonly notifications: NotificationService,
    private readonly leave: LeaveService,
    private readonly attendance: AttendanceService,
    private readonly documents: DocumentsService,
    private readonly biometric: BiometricService,
  ) {}

  @Public()
  @Post('approval-escalations')
  @HttpCode(200)
  escalations(@Headers('x-jobs-token') token?: string) {
    this.authorise(token);
    return this.approvals.runEscalations();
  }

  @Public()
  @Post('emails')
  @HttpCode(200)
  emails(@Headers('x-jobs-token') token?: string) {
    this.authorise(token);
    return this.notifications.flush();
  }

  @Public()
  @Post('leave-accrual')
  @HttpCode(200)
  leaveAccrual(@Headers('x-jobs-token') token?: string) {
    this.authorise(token);
    return this.leave.runAccrual();
  }

  @Public()
  @Post('attendance-nightly')
  @HttpCode(200)
  attendanceNightly(@Headers('x-jobs-token') token?: string) {
    this.authorise(token);
    return this.attendance.runNightly();
  }

  /** Every minute in office hours: starts the random presence checks and pushes them to phones. */
  @Public()
  @Post('presence-checks')
  @HttpCode(200)
  presenceChecks(@Headers('x-jobs-token') token?: string) {
    this.authorise(token);
    return this.attendance.pushPresenceChecks();
  }

  @Public()
  @Post('biometric-sync')
  @HttpCode(200)
  biometricSync(@Headers('x-jobs-token') token?: string) {
    this.authorise(token);
    return this.biometric.sync(null);
  }

  /**
   * The small program on the biometric PC sends the punches it has read from the machine's database here, as
   * text lines ("code,2026-11-11 09:41:07,in"). It has its own secret, so a leaked one can only add punches.
   */
  @Public()
  @Post('biometric-push')
  @HttpCode(200)
  biometricPush(@Headers('x-push-token') token: string | undefined, @Body() text: unknown, @Query('serial') serial?: string) {
    const expected = this.config.biometricPushToken;
    if (expected.length < 16) throw notFound('NOT_FOUND', 'Not found');
    const given = Buffer.from(token ?? '');
    const wanted = Buffer.from(expected);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw unauthorized('BAD_PUSH_TOKEN', 'Invalid token');
    if (typeof text !== 'string' || !text.trim()) throw badRequest('EMPTY_IMPORT', 'Nothing was sent. Send the punches as plain text');
    return this.biometric.importText(null, text, { source: 'api', serial: serial?.trim().slice(0, 60) || null });
  }

  @Public()
  @Post('selfie-cleanup')
  @HttpCode(200)
  selfieCleanup(@Headers('x-jobs-token') token?: string) {
    this.authorise(token);
    return this.attendance.purgeExpiredSelfies();
  }

  @Public()
  @Post('documents-cleanup')
  @HttpCode(200)
  documentsCleanup(@Headers('x-jobs-token') token?: string) {
    this.authorise(token);
    return this.documents.purgeAbandoned();
  }

  /** With no token configured the endpoints do not exist; otherwise the header must match exactly. */
  private authorise(token: string | undefined) {
    const expected = this.config.jobsToken;
    if (!expected) throw notFound('NOT_FOUND', 'Not found');
    const given = Buffer.from(token ?? '');
    const wanted = Buffer.from(expected);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      throw unauthorized('BAD_JOBS_TOKEN', 'Invalid job token');
    }
  }
}
