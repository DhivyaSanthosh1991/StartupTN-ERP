import { ApprovalsService } from '../src/approvals/approvals.service';
import { NotificationService } from '../src/common/notification.service';
import { addDays, todayIst } from '../src/common/dates';
import { futureMonday } from './dates';
import { TestEnv, createTestEnv } from './helpers';
import { applyLeave, balanceOf, decide, inboxIds } from './leave-helpers';

const hours = (n: number) => new Date(Date.now() + n * 3_600_000);

describe('approval engine (driven through leave requests)', () => {
  let env: TestEnv;
  const monday = futureMonday();
  const year = Number(monday.slice(0, 4));

  beforeAll(async () => {
    env = await createTestEnv();
  });
  beforeEach(async () => {
    await env.reset();
    await env.db.query('delete from holidays');
  });
  afterAll(() => env.close());

  describe('building the approver chain', () => {
    it('sends a short leave to the reporting manager only', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, addDays(monday, 1));
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('pending');
      expect(res.body.currentApprover).toBe('Mani Kandan');

      const approvalId = res.body.approvalRequestId;
      expect(await inboxIds(await env.as('mani'))).toEqual([approvalId]);
      expect(await inboxIds(await env.as('ravi'))).toEqual([]);
      expect(await inboxIds(await env.as('hari'))).toEqual([]);
    });

    it('adds the department head for leave of five days or more, one step after the other', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, addDays(monday, 4));
      expect(res.body.days).toBe(5);
      const approvalId = res.body.approvalRequestId;

      // Step 2 is not visible to the head until the manager has acted.
      expect(await inboxIds(await env.as('hari'))).toEqual([]);

      const mani = await env.as('mani');
      expect((await decide(mani, approvalId, 'approve')).body.status).toBe('pending');
      expect((await priya.get(`/api/leave/requests/${res.body.id}`)).body.status).toBe('pending');
      expect((await priya.get(`/api/leave/requests/${res.body.id}`)).body.currentApprover).toBe('Hari Prasad');
      expect(await inboxIds(mani)).toEqual([]);

      const hari = await env.as('hari');
      expect(await inboxIds(hari)).toEqual([approvalId]);
      expect((await decide(hari, approvalId, 'approve')).body.status).toBe('approved');
      expect((await priya.get(`/api/leave/requests/${res.body.id}`)).body.status).toBe('approved');
    });

    it('skips a step that would make someone approve their own request', async () => {
      // Hari heads Operations, so the "department head" step resolves to himself and drops out.
      const hari = await env.as('hari');
      const res = await applyLeave(hari, 'CL', monday, addDays(monday, 4));
      const detail = await hari.get(`/api/approvals/${res.body.approvalRequestId}`);
      expect(detail.body.steps).toHaveLength(1);
      expect(detail.body.steps[0].approverName).toBe('Meena Sundaram');
    });

    it('falls back to HR when the requester has nobody above them', async () => {
      const meena = await env.as('meena');
      const res = await applyLeave(meena, 'CL', monday, monday);
      expect(res.status).toBe(201);
      const approvalId = res.body.approvalRequestId;
      expect(await inboxIds(await env.as('hema'))).toEqual([approvalId]);
      expect(await inboxIds(meena)).toEqual([]);
      expect((await decide(await env.as('hema'), approvalId, 'approve')).body.status).toBe('approved');
    });

    it('skips an approver who has left, and falls back to HR if that empties the chain', async () => {
      await env.db.query(`update employees set status = 'inactive' where id = $1`, [env.ids.manager]);
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, monday);
      // Operations head is not a configured step for a 1-day leave, so HR picks it up.
      expect(await inboxIds(await env.as('hema'))).toEqual([res.body.approvalRequestId]);
    });
  });

  describe('deciding', () => {
    it('approving a leave debits the balance', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, addDays(monday, 1));
      expect((await balanceOf(priya, 'CL', year)).available).toBe(10);
      await decide(await env.as('mani'), res.body.approvalRequestId, 'approve');
      const cl = await balanceOf(priya, 'CL', year);
      expect(cl).toMatchObject({ balance: 10, used: 2, pending: 0, available: 10 });
    });

    it('rejecting needs a reason, hands the days back and tells the employee', async () => {
      const priya = await env.as('priya');
      const mani = await env.as('mani');
      const res = await applyLeave(priya, 'CL', monday, addDays(monday, 1));
      const id = res.body.approvalRequestId;

      const noReason = await decide(mani, id, 'reject');
      expect(noReason.status).toBe(400);
      expect(noReason.body.code).toBe('COMMENT_REQUIRED');

      expect((await decide(mani, id, 'reject', 'Project deadline that week')).body.status).toBe('rejected');
      const mine = await priya.get('/api/leave/requests').query({ year });
      expect(mine.body[0]).toMatchObject({ status: 'rejected', lastComment: 'Project deadline that week' });
      expect(await balanceOf(priya, 'CL', year)).toMatchObject({ balance: 12, available: 12, used: 0 });

      const mail = await env.db.rows(`select subject from email_outbox where to_address = 'priya@startuptn.in'`);
      expect(mail.map((m) => m.subject)).toEqual([expect.stringMatching(/^Not approved:/)]);
    });

    it('a rejection stops the chain, so later approvers never see the request', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, addDays(monday, 4));
      await decide(await env.as('mani'), res.body.approvalRequestId, 'reject', 'Not possible this week');
      expect(await inboxIds(await env.as('hari'))).toEqual([]);
      const steps = await env.db.rows(`select status from approval_steps where approval_request_id = $1 order by step_order`, [res.body.approvalRequestId]);
      expect(steps.map((s) => s.status)).toEqual(['rejected', 'skipped']);
    });

    it('only the person whose turn it is can decide', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, addDays(monday, 4));
      const id = res.body.approvalRequestId;

      const peer = await decide(await env.as('ravi'), id, 'approve');
      expect(peer.status).toBe(403);
      expect(peer.body.code).toBe('NOT_YOUR_APPROVAL');

      // Step 2's approver cannot jump the queue either.
      expect((await decide(await env.as('hari'), id, 'approve')).status).toBe(403);
      // Nor can HR who is not on the chain.
      expect((await decide(await env.as('hema'), id, 'approve')).status).toBe(403);
    });

    it('nobody can decide their own request', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, monday);
      const own = await decide(priya, res.body.approvalRequestId, 'approve');
      expect(own.status).toBe(403);
      expect(own.body.code).toBe('OWN_REQUEST');

      const meena = await env.as('meena');
      const mres = await applyLeave(meena, 'CL', monday, monday);
      expect((await decide(meena, mres.body.approvalRequestId, 'approve')).status).toBe(403);
    });

    it('a decision cannot be made twice', async () => {
      const priya = await env.as('priya');
      const mani = await env.as('mani');
      const res = await applyLeave(priya, 'CL', monday, monday);
      await decide(mani, res.body.approvalRequestId, 'approve');
      const again = await decide(mani, res.body.approvalRequestId, 'approve');
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_DECIDED');
      // ...and the leave was debited exactly once.
      expect((await balanceOf(priya, 'CL', year)).used).toBe(1);
    });

    it('keeps a history for the approver', async () => {
      const priya = await env.as('priya');
      const mani = await env.as('mani');
      const res = await applyLeave(priya, 'CL', monday, monday);
      await decide(mani, res.body.approvalRequestId, 'approve', 'Enjoy');
      const hist = await mani.get('/api/approvals/history');
      expect(hist.body).toHaveLength(1);
      expect(hist.body[0]).toMatchObject({ requesterName: 'Priya Raman', decision: 'approved', comment: 'Enjoy', requestStatus: 'approved' });
    });

    it('shows the trail only to the requester, people on the chain, and HR', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, monday);
      const url = `/api/approvals/${res.body.approvalRequestId}`;
      for (const who of ['priya', 'mani', 'hema']) expect((await (await env.as(who)).get(url)).status).toBe(200);
      for (const who of ['ravi', 'arun']) expect((await (await env.as(who)).get(url)).status).toBe(403);
    });
  });

  describe('delegation', () => {
    it('lets a stand-in decide while the delegation is active', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, monday);
      const id = res.body.approvalRequestId;
      const ravi = await env.as('ravi');
      expect((await decide(ravi, id, 'approve')).status).toBe(403);

      const mani = await env.as('mani');
      const del = await mani.post('/api/approvals/delegations').send({ delegateId: env.ids.ravi, fromDate: todayIst(), toDate: addDays(todayIst(), 3) });
      expect(del.status).toBe(201);

      const inbox = await ravi.get('/api/approvals/inbox');
      expect(inbox.body).toHaveLength(1);
      expect(inbox.body[0].onBehalfOfOther).toBe(true);
      expect((await decide(ravi, id, 'approve')).body.status).toBe('approved');
    });

    it('does nothing once the dates have passed', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, monday);
      const mani = await env.as('mani');
      await mani.post('/api/approvals/delegations').send({ delegateId: env.ids.ravi, fromDate: addDays(todayIst(), -10), toDate: addDays(todayIst(), -5) });
      const ravi = await env.as('ravi');
      expect(await inboxIds(ravi)).toEqual([]);
      expect((await decide(ravi, res.body.approvalRequestId, 'approve')).status).toBe(403);
    });

    it('can be removed by the person who made it, but not by others', async () => {
      const mani = await env.as('mani');
      const del = await mani.post('/api/approvals/delegations').send({ delegateId: env.ids.ravi, fromDate: todayIst(), toDate: todayIst() });
      expect((await (await env.as('priya')).delete(`/api/approvals/delegations/${del.body.id}`)).status).toBe(403);
      expect((await mani.delete(`/api/approvals/delegations/${del.body.id}`)).status).toBe(204);
    });

    it('rejects delegating to yourself or to a former employee', async () => {
      const mani = await env.as('mani');
      expect((await mani.post('/api/approvals/delegations').send({ delegateId: env.ids.manager, fromDate: todayIst(), toDate: todayIst() })).body.code).toBe('SELF_DELEGATION');
      await env.db.query(`update employees set status = 'inactive' where id = $1`, [env.ids.ravi]);
      expect((await mani.post('/api/approvals/delegations').send({ delegateId: env.ids.ravi, fromDate: todayIst(), toDate: todayIst() })).body.code).toBe('DELEGATE_INVALID');
    });
  });

  describe('reminders and escalation', () => {
    it('reminds halfway through the allowed time, then escalates to HR when it runs out', async () => {
      const approvals = env.app.get(ApprovalsService);
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, monday);
      const id = res.body.approvalRequestId;

      expect(await approvals.runEscalations(hours(1))).toEqual({ reminded: 0, escalated: 0 });
      expect(await approvals.runEscalations(hours(25))).toEqual({ reminded: 1, escalated: 0 });
      expect(await approvals.runEscalations(hours(26))).toEqual({ reminded: 0, escalated: 0 }); // only one reminder per step
      expect(await approvals.runEscalations(hours(49))).toEqual({ reminded: 0, escalated: 1 });

      const mani = await env.as('mani');
      expect(await inboxIds(mani)).toEqual([]);
      expect((await decide(mani, id, 'approve')).status).toBe(403);
      const hema = await env.as('hema');
      expect(await inboxIds(hema)).toEqual([id]);

      const subjects = (await env.db.rows(`select to_address, subject from email_outbox order by created_at`)).map((m) => `${m.to_address}|${m.subject.split(':')[0]}`);
      expect(subjects).toEqual(expect.arrayContaining(['mani@startuptn.in|Approval needed', 'mani@startuptn.in|Reminder', 'hema@startuptn.in|Escalated to you']));

      expect((await decide(hema, id, 'approve')).body.status).toBe('approved');
      const audit = await env.db.rows(`select action from audit_log where entity_id = $1`, [id]);
      expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['approval.submit', 'approval.escalate', 'approval.approve']));
    });

    it('moves on to the next level before falling back to HR', async () => {
      const approvals = env.app.get(ApprovalsService);
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, addDays(monday, 4)); // manager, then department head
      await approvals.runEscalations(hours(49));
      expect(await inboxIds(await env.as('hari'))).toEqual([res.body.approvalRequestId]);
      expect(await inboxIds(await env.as('hema'))).toEqual([]);
    });
  });

  describe('workflow configuration', () => {
    it('applies to new requests only; requests in flight keep the chain they were submitted with', async () => {
      const priya = await env.as('priya');
      const first = await applyLeave(priya, 'CL', monday, monday);

      const hr = await env.as('hema');
      const put = await hr.put('/api/admin/workflows/leave').send({ steps: [{ approverKind: 'role', approverRole: 'hr_admin', slaHours: 24 }] });
      expect(put.status).toBe(200);
      expect(put.body.steps).toHaveLength(1);

      const second = await applyLeave(priya, 'CL', addDays(monday, 1), addDays(monday, 1));
      expect(await inboxIds(await env.as('mani'))).toEqual([first.body.approvalRequestId]);
      expect(await inboxIds(hr)).toEqual([second.body.approvalRequestId]);
    });

    it('is for HR only and validates its input', async () => {
      const priya = await env.as('priya');
      expect((await priya.put('/api/admin/workflows/leave').send({ steps: [{ approverKind: 'reporting_manager' }] })).status).toBe(403);
      const hr = await env.as('hema');
      expect((await hr.put('/api/admin/workflows/leave').send({ steps: [] })).status).toBe(400);
      expect((await hr.put('/api/admin/workflows/leave').send({ steps: [{ approverKind: 'role' }] })).status).toBe(400);
      expect((await hr.put('/api/admin/workflows/nonsense').send({ steps: [{ approverKind: 'reporting_manager' }] })).status).toBe(400);
    });
  });

  describe('email queue', () => {
    it('queues mail with the change, linking into the signed-in app (no one-click approval)', async () => {
      const priya = await env.as('priya');
      const res = await applyLeave(priya, 'CL', monday, monday);
      const mail = await env.db.rows(`select to_address, subject, body_text from email_outbox`);
      expect(mail).toHaveLength(1);
      expect(mail[0].to_address).toBe('mani@startuptn.in');
      expect(mail[0].subject).toMatch(/^Approval needed: Casual Leave/);
      expect(mail[0].body_text).toContain(`http://localhost:3000/approvals?request=${res.body.approvalRequestId}`);
    });

    it('sends each queued message exactly once, even when two sends overlap', async () => {
      const notify = env.app.get(NotificationService);
      for (let i = 0; i < 6; i++) await notify.queue({ to: `u${i}@startuptn.in`, subject: `s${i}`, text: 't' });
      const send = jest.spyOn(notify as any, 'send').mockImplementation(() => new Promise((r) => setTimeout(r, 15)));
      try {
        const [a, b] = await Promise.all([notify.flush(), notify.flush()]);
        expect(send).toHaveBeenCalledTimes(6);
        expect(a.sent + b.sent).toBe(6);
        expect(await env.db.rows(`select 1 from email_outbox where status = 'sent'`)).toHaveLength(6);
      } finally {
        send.mockRestore();
      }
    });

    it('retries a failed send, and gives up after five attempts', async () => {
      const notify = env.app.get(NotificationService);
      await notify.queue({ to: 'x@startuptn.in', subject: 'hello', text: 't' });
      const send = jest.spyOn(notify as any, 'send').mockRejectedValue(new Error('SES unavailable'));
      try {
        for (let i = 0; i < 4; i++) expect(await notify.flush()).toEqual({ sent: 0, failed: 1 });
        expect((await env.db.one(`select status, attempts from email_outbox`))).toMatchObject({ status: 'queued', attempts: 4 });
        await notify.flush();
        expect((await env.db.one(`select status, attempts, last_error from email_outbox`))).toMatchObject({ status: 'failed', attempts: 5, last_error: 'SES unavailable' });
        expect(await notify.flush()).toEqual({ sent: 0, failed: 0 });
      } finally {
        send.mockRestore();
      }
    });
  });
});
