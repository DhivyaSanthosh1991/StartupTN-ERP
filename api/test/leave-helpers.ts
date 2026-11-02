import * as request from 'supertest';

type Agent = request.Agent;

export async function typeId(agent: Agent, code: string): Promise<string> {
  const res = await agent.get('/api/leave/types');
  const t = (res.body as { id: string; code: string }[]).find((x) => x.code === code);
  if (!t) throw new Error(`leave type ${code} not offered: ${JSON.stringify(res.body)}`);
  return t.id;
}

export async function applyLeave(
  agent: Agent, code: string, fromDate: string, toDate: string, extra: Record<string, unknown> = {},
) {
  // Look the type up first: supertest must not have two requests in flight on one agent.
  const leaveTypeId = await typeId(agent, code);
  return agent.post('/api/leave/requests').send({ leaveTypeId, fromDate, toDate, reason: 'Family function', ...extra });
}

export async function balanceOf(agent: Agent, code: string, year?: number) {
  const res = await agent.get('/api/leave/balances').query(year ? { year } : {});
  return (res.body as any[]).find((b) => b.code === code);
}

export const decide = (agent: Agent, approvalRequestId: string, decision: 'approve' | 'reject', comment?: string) =>
  agent.post(`/api/approvals/${approvalRequestId}/decision`).send({ decision, comment });

export async function inboxIds(agent: Agent): Promise<string[]> {
  const res = await agent.get('/api/approvals/inbox');
  return (res.body as { approvalRequestId: string }[]).map((r) => r.approvalRequestId);
}
