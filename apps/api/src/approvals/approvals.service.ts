import { Injectable } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { AuthUser, Role, hasRole } from '../common/auth.types';
import { todayIst } from '../common/dates';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { NotificationService } from '../common/notification.service';
import { Db, Queryable } from '../db/db.service';
import { ApprovalHandler, ApprovalRequestRow, RequestType, SubmitInput } from './approvals.types';

interface StepRow {
  id: string;
  approval_request_id: string;
  step_order: number;
  approver_id: string | null;
  approver_role: string | null;
  status: string;
  sla_hours: number;
  due_at: Date | null;
}

const TYPE_LABEL: Record<RequestType, string> = {
  leave: 'Leave', od: 'On duty', permission: 'Permission', regularisation: 'Attendance correction', od_home: 'Going home after duty',
};

/** Roles tried, in order, when a chain cannot be resolved or a step goes unanswered. */
const FALLBACK_ROLES: Role[] = ['hr_admin', 'md', 'super_admin'];

@Injectable()
export class ApprovalsService {
  private readonly handlers = new Map<RequestType, ApprovalHandler>();

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notify: NotificationService,
  ) {}

  registerHandler(type: RequestType, handler: ApprovalHandler) {
    this.handlers.set(type, handler);
  }

  private handlerFor(type: RequestType): ApprovalHandler {
    const h = this.handlers.get(type);
    if (!h) throw new Error(`No approval handler registered for "${type}"`);
    return h;
  }

  // ------------------------------------------------------------------ submit

  /**
   * Builds the approver chain for a new request from the workflow configured for its type:
   *  - steps whose "min days" condition is not met are left out;
   *  - a step that resolves to the requester themself, to an inactive person, or to the same
   *    person as the previous step is skipped (nobody approves their own request);
   *  - if nothing is left (e.g. the MD applying for leave) the request goes to HR, then the MD,
   *    then a super admin — whoever exists and is not the requester.
   * Call inside the caller's transaction so the request and its approval are created together.
   */
  async submit(q: Queryable, input: SubmitInput): Promise<string> {
    const size = input.size ?? 1;
    const wf = (await q.query(
      'select id from approval_workflows where request_type = $1 and active', [input.type])).rows[0];
    if (!wf) throw badRequest('NO_WORKFLOW', `No active approval workflow is configured for ${input.type}`);

    const stepDefs = (await q.query(
      'select * from approval_workflow_steps where workflow_id = $1 order by step_order', [wf.id])).rows
      .filter((s) => s.min_days === null || size >= s.min_days);

    const requester = (await q.query(
      `select e.id, e.full_name, e.reporting_manager_id, d.head_employee_id
         from employees e left join departments d on d.id = e.department_id where e.id = $1`,
      [input.requesterId])).rows[0];

    const chain: { approverId: string | null; role: string | null; sla: number }[] = [];
    for (const def of stepDefs) {
      let approverId: string | null = null;
      let role: string | null = null;
      if (def.approver_kind === 'role') role = def.approver_role;
      else {
        approverId =
          def.approver_kind === 'reporting_manager' ? requester.reporting_manager_id
          : def.approver_kind === 'department_head' ? requester.head_employee_id
          : def.approver_employee_id;
        if (!approverId || approverId === input.requesterId || !(await this.isActive(q, approverId))) continue;
      }
      const prev = chain.at(-1);
      if (prev && approverId && prev.approverId === approverId) continue;
      if (prev && role && prev.role === role) continue;
      chain.push({ approverId, role, sla: def.sla_hours });
    }

    if (!chain.length) {
      const role = await this.fallbackRole(q, input.requesterId);
      if (!role) throw badRequest('NO_APPROVER', 'No approver is available for this request. Please contact HR');
      chain.push({ approverId: null, role, sla: 48 });
    }

    const req = (await q.query(
      `insert into approval_requests (request_type, ref_id, requester_id, workflow_id, summary, size)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [input.type, input.refId, input.requesterId, wf.id, input.summary, size])).rows[0];

    let firstStepId = '';
    for (const [i, c] of chain.entries()) {
      const first = i === 0;
      const step = (await q.query(
        `insert into approval_steps (approval_request_id, step_order, approver_id, approver_role, status, sla_hours, started_at, due_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [req.id, i + 1, c.approverId, c.role, first ? 'pending' : 'waiting', c.sla,
         first ? new Date() : null, first ? new Date(Date.now() + c.sla * 3_600_000) : null])).rows[0];
      if (first) firstStepId = step.id;
    }

    await this.audit.record({ actorId: input.requesterId, action: 'approval.submit', entityType: 'approval_request', entityId: req.id,
      after: { type: input.type, refId: input.refId, steps: chain.length } }, q);
    await this.notifyStepApprovers(q, firstStepId, 'new');
    return req.id;
  }

  private async isActive(q: Queryable, employeeId: string) {
    return ((await q.query(`select 1 from employees where id = $1 and status = 'active'`, [employeeId])).rowCount ?? 0) > 0;
  }

  private async fallbackRole(q: Queryable, requesterId: string, skipRole?: string | null): Promise<Role | null> {
    for (const role of FALLBACK_ROLES) {
      if (role === skipRole) continue;
      const r = await q.query(
        `select 1 from employee_roles r join employees e on e.id = r.employee_id
          where r.role = $1 and e.status = 'active' and e.id <> $2 limit 1`, [role, requesterId]);
      if (r.rowCount) return role;
    }
    return null;
  }

  // ------------------------------------------------------------------ decide

  async decide(actor: AuthUser, approvalRequestId: string, decision: 'approve' | 'reject', comment?: string) {
    const note = comment?.trim() || null;
    if (decision === 'reject' && (!note || note.length < 3)) {
      throw badRequest('COMMENT_REQUIRED', 'Please give a reason for rejecting');
    }

    return this.db.tx(async (q) => {
      const row = (await q.query('select * from approval_requests where id = $1 for update', [approvalRequestId])).rows[0];
      if (!row) throw notFound('APPROVAL_NOT_FOUND', 'Approval request not found');
      if (row.status !== 'pending') throw conflict('ALREADY_DECIDED', `This request was already ${row.status}`);
      if (row.requester_id === actor.id) throw forbidden('OWN_REQUEST', 'You cannot decide your own request');

      const step = (await q.query(
        `select * from approval_steps where approval_request_id = $1 and status = 'pending' order by step_order limit 1`,
        [approvalRequestId])).rows[0] as StepRow | undefined;
      if (!step || !(await this.canAct(q, actor, step))) {
        throw forbidden('NOT_YOUR_APPROVAL', 'This request is not waiting for your decision');
      }

      const request: ApprovalRequestRow = {
        id: row.id, requestType: row.request_type, refId: row.ref_id,
        requesterId: row.requester_id, size: row.size, summary: row.summary,
      };

      await q.query(
        `update approval_steps set status = $2, acted_by = $3, acted_at = now(), comment = $4 where id = $1`,
        [step.id, decision === 'approve' ? 'approved' : 'rejected', actor.id, note]);

      let outcome: 'approved' | 'rejected' | 'pending';
      if (decision === 'reject') {
        await q.query(`update approval_steps set status = 'skipped' where approval_request_id = $1 and status = 'waiting'`, [row.id]);
        await q.query(`update approval_requests set status = 'rejected', completed_at = now() where id = $1`, [row.id]);
        await this.handlerFor(request.requestType).onRejected(q, request, note!);
        outcome = 'rejected';
      } else {
        const next = (await q.query(
          `select * from approval_steps where approval_request_id = $1 and status = 'waiting' order by step_order limit 1`,
          [row.id])).rows[0] as StepRow | undefined;
        if (next) {
          await this.activateStep(q, next);
          outcome = 'pending';
        } else {
          await q.query(`update approval_requests set status = 'approved', completed_at = now() where id = $1`, [row.id]);
          await this.handlerFor(request.requestType).onApproved(q, request);
          outcome = 'approved';
        }
      }

      await this.audit.record({
        actorId: actor.id, action: `approval.${decision}`, entityType: 'approval_request', entityId: row.id,
        after: { step: step.step_order, comment: note, outcome },
      }, q);

      if (outcome === 'pending') {
        const next = (await q.query(`select id from approval_steps where approval_request_id = $1 and status = 'pending'`, [row.id])).rows[0];
        await this.notifyStepApprovers(q, next.id, 'new');
      } else {
        await this.notifyRequesterOutcome(q, request, outcome, actor.fullName, note);
      }
      return { id: row.id, status: outcome };
    });
  }

  private async activateStep(q: Queryable, step: StepRow) {
    await q.query(
      `update approval_steps set status = 'pending', started_at = now(),
              due_at = now() + make_interval(hours => $2), reminded_at = null where id = $1`,
      [step.id, step.sla_hours]);
  }

  /** The step's named approver, anyone holding the step's role, or a stand-in on an active delegation. */
  private async canAct(q: Queryable, actor: AuthUser, step: StepRow): Promise<boolean> {
    if (step.approver_id === actor.id) return true;
    if (step.approver_role && actor.roles.includes(step.approver_role as Role)) return true;
    if (step.approver_id) {
      const d = await q.query(
        `select 1 from approval_delegations
          where delegator_id = $1 and delegate_id = $2 and $3::date between from_date and to_date limit 1`,
        [step.approver_id, actor.id, todayIst()]);
      if (d.rowCount) return true;
    }
    return false;
  }

  // -------------------------------------------------------- cancel (by caller)

  /** The requester withdrew a request that is still pending. Run inside the caller's transaction. */
  async cancelPending(q: Queryable, approvalRequestId: string, actorId: string) {
    await q.query(`update approval_steps set status = 'skipped' where approval_request_id = $1 and status in ('pending','waiting')`, [approvalRequestId]);
    await q.query(`update approval_requests set status = 'cancelled', completed_at = now() where id = $1 and status = 'pending'`, [approvalRequestId]);
    await this.audit.record({ actorId, action: 'approval.cancel', entityType: 'approval_request', entityId: approvalRequestId }, q);
  }

  /** An already-approved request was reversed by its owner (e.g. leave cancelled before it started). */
  async cancelApproved(q: Queryable, approvalRequestId: string, actorId: string) {
    await q.query(`update approval_requests set status = 'cancelled', completed_at = now() where id = $1 and status = 'approved'`, [approvalRequestId]);
    await this.audit.record({ actorId, action: 'approval.cancel_after_approval', entityType: 'approval_request', entityId: approvalRequestId }, q);
  }

  // ------------------------------------------------------------------- views

  /** Requests currently waiting for this person (directly, by role, or on behalf of someone who delegated). */
  async inbox(actor: AuthUser) {
    const rows = await this.db.rows(
      `select s.id as step_id, s.step_order, s.due_at, r.id as approval_request_id, r.request_type, r.ref_id,
              r.summary, r.created_at, e.id as requester_id, e.full_name as requester_name, e.designation as requester_designation,
              (select count(*) from approval_steps x where x.approval_request_id = r.id and x.status <> 'skipped') as total_steps,
              (s.approver_id is not null and s.approver_id <> $1) as on_behalf_of_other
         from approval_steps s
         join approval_requests r on r.id = s.approval_request_id
         join employees e on e.id = r.requester_id
        where s.status = 'pending' and r.status = 'pending' and r.requester_id <> $1
          and ( s.approver_id = $1
                or s.approver_role = any($2::text[])
                or s.approver_id in (select delegator_id from approval_delegations
                                      where delegate_id = $1 and $3::date between from_date and to_date) )
        order by s.due_at nulls last, r.created_at`,
      [actor.id, actor.roles, todayIst()]);
    return rows.map((r) => ({
      approvalRequestId: r.approval_request_id, stepId: r.step_id, type: r.request_type as RequestType,
      typeLabel: TYPE_LABEL[r.request_type as RequestType], refId: r.ref_id, summary: r.summary,
      submittedAt: r.created_at, dueAt: r.due_at, stepNumber: r.step_order, totalSteps: Number(r.total_steps),
      requester: { id: r.requester_id, fullName: r.requester_name, designation: r.requester_designation },
      onBehalfOfOther: r.on_behalf_of_other,
    }));
  }

  async history(actor: AuthUser, limit = 100) {
    const rows = await this.db.rows(
      `select s.id as step_id, s.status as decision, s.comment, s.acted_at, r.id as approval_request_id, r.request_type,
              r.summary, r.status as request_status, e.full_name as requester_name
         from approval_steps s
         join approval_requests r on r.id = s.approval_request_id
         join employees e on e.id = r.requester_id
        where s.acted_by = $1 order by s.acted_at desc limit $2`, [actor.id, limit]);
    return rows.map((r) => ({
      approvalRequestId: r.approval_request_id, type: r.request_type as RequestType, summary: r.summary,
      requesterName: r.requester_name, decision: r.decision, comment: r.comment, actedAt: r.acted_at, requestStatus: r.request_status,
    }));
  }

  /** The full trail of one request. Visible to the requester, anyone in its chain, and HR. */
  async detail(viewer: AuthUser, approvalRequestId: string) {
    const req = await this.db.one(
      `select r.*, e.full_name as requester_name from approval_requests r join employees e on e.id = r.requester_id where r.id = $1`,
      [approvalRequestId]);
    if (!req) throw notFound('APPROVAL_NOT_FOUND', 'Approval request not found');
    const steps = await this.db.rows(
      `select s.step_order, s.status, s.approver_id, s.approver_role, a.full_name as approver_name,
              s.acted_by, b.full_name as acted_by_name, s.acted_at, s.comment, s.due_at
         from approval_steps s
         left join employees a on a.id = s.approver_id
         left join employees b on b.id = s.acted_by
        where s.approval_request_id = $1 order by s.step_order`, [approvalRequestId]);

    const inChain = steps.some((s) => s.approver_id === viewer.id || s.acted_by === viewer.id ||
      (s.approver_role && viewer.roles.includes(s.approver_role)));
    if (req.requester_id !== viewer.id && !inChain && !hasRole(viewer, 'hr_admin')) {
      throw forbidden('FORBIDDEN', 'You do not have access to this request');
    }
    return {
      id: req.id, type: req.request_type as RequestType, refId: req.ref_id, status: req.status, summary: req.summary,
      requester: { id: req.requester_id, fullName: req.requester_name }, createdAt: req.created_at, completedAt: req.completed_at,
      steps: steps.map((s) => ({
        order: s.step_order, status: s.status, approverId: s.approver_id, approverRole: s.approver_role,
        approverName: s.approver_name, actedByName: s.acted_by_name, actedAt: s.acted_at, comment: s.comment, dueAt: s.due_at,
      })),
    };
  }

  /** Compact status for list screens: where is this request, and what happened. */
  async summaries(ids: string[]) {
    if (!ids.length) return new Map<string, { status: string; currentApprover: string | null; lastComment: string | null }>();
    const rows = await this.db.rows(
      `select r.id, r.status,
              (select coalesce(a.full_name, 'Anyone with role ' || s.approver_role) from approval_steps s
                 left join employees a on a.id = s.approver_id
                where s.approval_request_id = r.id and s.status = 'pending' limit 1) as current_approver,
              (select s.comment from approval_steps s where s.approval_request_id = r.id and s.comment is not null
                order by s.acted_at desc limit 1) as last_comment
         from approval_requests r where r.id = any($1::uuid[])`, [ids]);
    return new Map(rows.map((r) => [r.id as string, { status: r.status as string, currentApprover: r.current_approver as string | null, lastComment: r.last_comment as string | null }]));
  }

  // ------------------------------------------------------------- delegation

  async createDelegation(actor: AuthUser, input: { delegateId: string; fromDate: string; toDate: string }) {
    if (input.delegateId === actor.id) throw badRequest('SELF_DELEGATION', 'You cannot delegate to yourself');
    if (input.toDate < input.fromDate) throw badRequest('BAD_DATES', 'The end date is before the start date');
    if (!(await this.isActive(this.db, input.delegateId))) throw badRequest('DELEGATE_INVALID', 'The stand-in must be an active employee');
    return this.db.tx(async (q) => {
      const r = await q.query(
        `insert into approval_delegations (delegator_id, delegate_id, from_date, to_date) values ($1,$2,$3,$4) returning id`,
        [actor.id, input.delegateId, input.fromDate, input.toDate]);
      await this.audit.record({ actorId: actor.id, action: 'delegation.create', entityType: 'delegation', entityId: r.rows[0].id, after: input }, q);
      return { id: r.rows[0].id as string, ...input };
    });
  }

  async delegations(actor: AuthUser) {
    const rows = await this.db.rows(
      `select d.id, d.delegator_id, a.full_name as delegator_name, d.delegate_id, b.full_name as delegate_name, d.from_date, d.to_date
         from approval_delegations d
         join employees a on a.id = d.delegator_id join employees b on b.id = d.delegate_id
        where (d.delegator_id = $1 or d.delegate_id = $1) and d.to_date >= $2::date order by d.from_date`,
      [actor.id, todayIst()]);
    return rows.map((r) => ({
      id: r.id, delegatorId: r.delegator_id, delegatorName: r.delegator_name, delegateId: r.delegate_id,
      delegateName: r.delegate_name, fromDate: r.from_date, toDate: r.to_date,
    }));
  }

  async deleteDelegation(actor: AuthUser, id: string) {
    await this.db.tx(async (q) => {
      const r = await q.query(`select delegator_id from approval_delegations where id = $1`, [id]);
      if (!r.rowCount) throw notFound('DELEGATION_NOT_FOUND', 'Delegation not found');
      if (r.rows[0].delegator_id !== actor.id && !hasRole(actor, 'hr_admin')) throw forbidden('FORBIDDEN', 'Only the person who delegated can remove it');
      await q.query('delete from approval_delegations where id = $1', [id]);
      await this.audit.record({ actorId: actor.id, action: 'delegation.delete', entityType: 'delegation', entityId: id }, q);
    });
  }

  // ------------------------------------------------- reminders and escalation

  /**
   * Run on a schedule. Halfway through a step's allowed time the approver gets a reminder; once
   * it runs out the step is marked escalated and passes to the next level — or, at the end of the
   * chain, to HR / the MD. If no one else exists the step is simply renewed with a fresh deadline.
   */
  async runEscalations(now: Date = new Date()): Promise<{ reminded: number; escalated: number }> {
    let reminded = 0;
    let escalated = 0;

    const due = await this.db.rows(
      `select s.id from approval_steps s join approval_requests r on r.id = s.approval_request_id
        where s.status = 'pending' and r.status = 'pending' and s.reminded_at is null and s.due_at > $1
          and $1 >= s.started_at + (s.due_at - s.started_at) / 2`, [now]);
    for (const { id } of due) {
      await this.db.tx(async (q) => {
        const claimed = await q.query(`update approval_steps set reminded_at = $2 where id = $1 and reminded_at is null returning id`, [id, now]);
        if (!claimed.rowCount) return;
        await this.notifyStepApprovers(q, id, 'reminder');
        reminded++;
      });
    }

    const overdue = await this.db.rows(
      `select s.id, s.approval_request_id from approval_steps s join approval_requests r on r.id = s.approval_request_id
        where s.status = 'pending' and r.status = 'pending' and s.due_at <= $1 order by s.due_at`, [now]);
    for (const o of overdue) {
      await this.db.tx(async (q) => {
        const req = (await q.query(`select * from approval_requests where id = $1 and status = 'pending' for update skip locked`, [o.approval_request_id])).rows[0];
        if (!req) return;
        const step = (await q.query(`select * from approval_steps where id = $1 and status = 'pending'`, [o.id])).rows[0] as StepRow | undefined;
        if (!step) return;

        const next = (await q.query(
          `select * from approval_steps where approval_request_id = $1 and status = 'waiting' order by step_order limit 1`, [req.id])).rows[0] as StepRow | undefined;

        let target: StepRow | undefined = next;
        let newStepId: string | null = null;
        if (!target) {
          const role = await this.fallbackRole(q, req.requester_id, step.approver_role);
          if (role) {
            const order = (await q.query(`select max(step_order) + 1 as n from approval_steps where approval_request_id = $1`, [req.id])).rows[0].n;
            const ins = (await q.query(
              `insert into approval_steps (approval_request_id, step_order, approver_role, status, sla_hours) values ($1, $2, $3, 'waiting', 48) returning *`,
              [req.id, order, role])).rows[0] as StepRow;
            target = ins;
          }
        }

        if (!target) {
          // Nobody further up: keep the step open with a fresh deadline and nudge again.
          await q.query(`update approval_steps set started_at = $2::timestamptz, due_at = $2::timestamptz + make_interval(hours => sla_hours), reminded_at = null where id = $1`, [step.id, now]);
          await this.notifyStepApprovers(q, step.id, 'reminder');
          return;
        }

        await q.query(`update approval_steps set status = 'escalated', acted_at = $2, comment = 'No action within the allowed time' where id = $1`, [step.id, now]);
        await q.query(
          `update approval_steps set status = 'pending', started_at = $2::timestamptz, due_at = $2::timestamptz + make_interval(hours => sla_hours), reminded_at = null where id = $1`,
          [target.id, now]);
        newStepId = target.id;
        await this.audit.record({ actorId: null, action: 'approval.escalate', entityType: 'approval_request', entityId: req.id, after: { fromStep: step.step_order, toStep: target.step_order } }, q);
        await this.notifyStepApprovers(q, newStepId, 'escalated');
        escalated++;
      });
    }
    return { reminded, escalated };
  }

  // ---------------------------------------------------------- notifications

  private async notifyStepApprovers(q: Queryable, stepId: string, kind: 'new' | 'reminder' | 'escalated') {
    const step = (await q.query(
      `select s.*, r.summary, r.id as request_id, r.requester_id, e.full_name as requester_name
         from approval_steps s join approval_requests r on r.id = s.approval_request_id join employees e on e.id = r.requester_id
        where s.id = $1`, [stepId])).rows[0];
    if (!step) return;

    const recipients = (await q.query(
      `select distinct e.id, e.full_name, e.official_email from employees e
        where e.status = 'active' and e.id <> $4 and (
              e.id = $1
           or e.id in (select employee_id from employee_roles where role = $2)
           or e.id in (select delegate_id from approval_delegations where delegator_id = $1 and $3::date between from_date and to_date))`,
      [step.approver_id, step.approver_role, todayIst(), step.requester_id])).rows;

    const subject =
      kind === 'reminder' ? `Reminder: approval pending — ${step.summary}`
      : kind === 'escalated' ? `Escalated to you: ${step.summary}`
      : `Approval needed: ${step.summary}`;
    for (const person of recipients) {
      await this.notify.queue({
        to: person.official_email, subject,
        text: [`Hello ${person.full_name},`, '',
          kind === 'escalated'
            ? `A request from ${step.requester_name} was not actioned in time and has been escalated to you:`
            : `${step.requester_name} has submitted a request that needs your decision:`,
          '', step.summary, '', `Review and decide: ${this.notify.link(`/approvals?request=${step.request_id}`)}`, '',
          `Please act within ${step.sla_hours} hours; otherwise it moves to the next level.`].join('\n'),
      }, q);
    }
  }

  private async notifyRequesterOutcome(q: Queryable, request: ApprovalRequestRow, outcome: string, decidedBy: string, note: string | null) {
    const who = (await q.query('select full_name, official_email from employees where id = $1', [request.requesterId])).rows[0];
    if (!who) return;
    await this.notify.queue({
      to: who.official_email,
      subject: `${outcome === 'approved' ? 'Approved' : 'Not approved'}: ${request.summary}`,
      text: [`Hello ${who.full_name},`, '',
        `Your request was ${outcome} by ${decidedBy}:`, '', request.summary,
        ...(note ? ['', `Comment: ${note}`] : []), '', `Details: ${this.notify.link('/requests')}`].join('\n'),
    }, q);
  }

  // ------------------------------------------------------- workflow admin

  async workflows() {
    const wfs = await this.db.rows(`select id, request_type, name, active from approval_workflows order by request_type`);
    const steps = await this.db.rows(
      `select s.*, e.full_name as employee_name from approval_workflow_steps s
         left join employees e on e.id = s.approver_employee_id order by s.workflow_id, s.step_order`);
    return wfs.map((w) => ({
      requestType: w.request_type as RequestType, name: w.name, active: w.active,
      steps: steps.filter((s) => s.workflow_id === w.id).map((s) => ({
        order: s.step_order, approverKind: s.approver_kind, approverRole: s.approver_role,
        approverEmployeeId: s.approver_employee_id, approverEmployeeName: s.employee_name,
        minDays: s.min_days, slaHours: s.sla_hours,
      })),
    }));
  }

  async setWorkflowSteps(actor: AuthUser, type: RequestType, steps: {
    approverKind: 'reporting_manager' | 'department_head' | 'role' | 'employee';
    approverRole?: string | null; approverEmployeeId?: string | null; minDays?: number | null; slaHours?: number;
  }[]) {
    const before = (await this.workflows()).find((w) => w.requestType === type);
    if (!before) throw notFound('WORKFLOW_NOT_FOUND', 'Workflow not found');
    await this.db.tx(async (q) => {
      const wf = (await q.query('select id from approval_workflows where request_type = $1', [type])).rows[0];
      await q.query('delete from approval_workflow_steps where workflow_id = $1', [wf.id]);
      for (const [i, s] of steps.entries()) {
        await q.query(
          `insert into approval_workflow_steps (workflow_id, step_order, approver_kind, approver_role, approver_employee_id, min_days, sla_hours)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [wf.id, i + 1, s.approverKind, s.approverRole ?? null, s.approverEmployeeId ?? null, s.minDays ?? null, s.slaHours ?? 48]);
      }
      await this.audit.record({ actorId: actor.id, action: 'workflow.update', entityType: 'workflow', entityId: type, before: before.steps, after: steps }, q);
    });
    return (await this.workflows()).find((w) => w.requestType === type);
  }
}
