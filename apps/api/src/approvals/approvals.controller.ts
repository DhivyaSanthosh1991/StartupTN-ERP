import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../common/auth.types';
import { dateStr, uuid, zodPipe } from '../common/zod.pipe';
import { ApprovalsService } from './approvals.service';
import { REQUEST_TYPES, RequestType } from './approvals.types';

const decisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().trim().max(1000).optional(),
});

const delegationBody = z.object({ delegateId: uuid, fromDate: dateStr, toDate: dateStr });

const roleEnum = z.enum(['hod', 'md', 'hr_admin', 'finance', 'super_admin']);
const stepSchema = z
  .object({
    approverKind: z.enum(['reporting_manager', 'department_head', 'role', 'employee']),
    approverRole: roleEnum.nullish(),
    approverEmployeeId: uuid.nullish(),
    minDays: z.number().min(0.5).max(365).nullish(),
    slaHours: z.number().int().min(1).max(720).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.approverKind === 'role' && !s.approverRole) {
      ctx.addIssue({ code: 'custom', path: ['approverRole'], message: 'Choose a role for this step' });
    }
    if (s.approverKind === 'employee' && !s.approverEmployeeId) {
      ctx.addIssue({ code: 'custom', path: ['approverEmployeeId'], message: 'Choose an employee for this step' });
    }
  });
const workflowBody = z.object({ steps: z.array(stepSchema).min(1).max(5) });
const typeParam = z.enum(REQUEST_TYPES as [RequestType, ...RequestType[]]);

@Controller()
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get('approvals/inbox')
  inbox(@CurrentUser() user: AuthUser) {
    return this.approvals.inbox(user);
  }

  @Get('approvals/history')
  history(@CurrentUser() user: AuthUser) {
    return this.approvals.history(user);
  }

  @Get('approvals/delegations')
  delegations(@CurrentUser() user: AuthUser) {
    return this.approvals.delegations(user);
  }

  @Post('approvals/delegations')
  createDelegation(@CurrentUser() user: AuthUser, @Body(zodPipe(delegationBody)) body: z.infer<typeof delegationBody>) {
    return this.approvals.createDelegation(user, body);
  }

  @Delete('approvals/delegations/:id')
  @HttpCode(204)
  deleteDelegation(@CurrentUser() user: AuthUser, @Param('id', zodPipe(uuid)) id: string) {
    return this.approvals.deleteDelegation(user, id);
  }

  @Get('approvals/:id')
  detail(@CurrentUser() user: AuthUser, @Param('id', zodPipe(uuid)) id: string) {
    return this.approvals.detail(user, id);
  }

  @Post('approvals/:id/decision')
  @HttpCode(200)
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id', zodPipe(uuid)) id: string,
    @Body(zodPipe(decisionBody)) body: z.infer<typeof decisionBody>,
  ) {
    return this.approvals.decide(user, id, body.decision, body.comment);
  }

  @Roles('hr_admin')
  @Get('admin/workflows')
  workflows() {
    return this.approvals.workflows();
  }

  @Roles('hr_admin')
  @Put('admin/workflows/:type')
  setWorkflow(
    @CurrentUser() user: AuthUser,
    @Param('type', zodPipe(typeParam)) type: RequestType,
    @Body(zodPipe(workflowBody)) body: z.infer<typeof workflowBody>,
  ) {
    return this.approvals.setWorkflowSteps(user, type, body.steps);
  }
}
