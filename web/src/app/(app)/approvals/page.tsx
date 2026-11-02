'use client';

import { useEffect, useState } from 'react';
import { ApprovalTrail } from '@/components/approval-trail';
import { Badge, Button, Dialog, Empty, ErrorNote, Field, FormActions, Input, Loading, Notice, PageHeader, Panel, Section, Select, Tabs, Textarea, useToast } from '@/components/ui';
import { api, errorText, useApi } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtRange, relative, todayIst } from '@/lib/dates';
import { REQUEST_TYPE_LABEL } from '@/lib/labels';
import { useMe } from '@/lib/session';
import type { DirectoryPerson } from '@/lib/types';
import { useTab } from '@/lib/use-tab';

interface InboxItem {
  approvalRequestId: string; stepId: string; type: string; typeLabel: string; summary: string; submittedAt: string; dueAt: string | null;
  stepNumber: number; totalSteps: number; requester: { id: string; fullName: string; designation: string | null }; onBehalfOfOther: boolean;
}
interface HistoryItem { approvalRequestId: string; type: string; summary: string; requesterName: string; decision: string; comment: string | null; actedAt: string; requestStatus: string }
interface Delegation { id: string; delegatorId: string; delegatorName: string; delegateId: string; delegateName: string; fromDate: string; toDate: string }

type TabId = 'waiting' | 'done' | 'standins';

export default function ApprovalsPage() {
  const [tab, setTab] = useTab<TabId>(['waiting', 'done', 'standins'], 'waiting');
  const inbox = useApi<InboxItem[]>('/approvals/inbox');
  const [highlight, setHighlight] = useState<string | null>(null);
  const [trail, setTrail] = useState<string | null>(null);

  // A link from an email lands here with ?request=<id>.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('request');
    if (id) { setHighlight(id); setTrail(id); }
  }, []);

  return (
    <div>
      <PageHeader title="Approvals" description="Requests from your team that are waiting for your decision." />
      <Tabs tabs={[
        { id: 'waiting', label: inbox.data?.length ? `Waiting for you (${inbox.data.length})` : 'Waiting for you' },
        { id: 'done', label: 'Decided by you' },
        { id: 'standins', label: 'Stand-ins' },
      ]} value={tab} onChange={setTab} />

      {tab === 'waiting' && <Waiting inbox={inbox} highlight={highlight} onTrail={setTrail} />}
      {tab === 'done' && <History onTrail={setTrail} />}
      {tab === 'standins' && <StandIns />}
      <ApprovalTrail approvalRequestId={trail} onClose={() => setTrail(null)} />
    </div>
  );
}

function Waiting({ inbox, highlight, onTrail }: { inbox: ReturnType<typeof useApi<InboxItem[]>>; highlight: string | null; onTrail: (id: string) => void }) {
  const toast = useToast();
  const [deciding, setDeciding] = useState<{ item: InboxItem; decision: 'approve' | 'reject' } | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function decide() {
    if (!deciding) return;
    if (deciding.decision === 'reject' && comment.trim().length < 3) return setError('Please say why, so the person knows what to change.');
    setBusy(true);
    setError('');
    try {
      await api(`/approvals/${deciding.item.approvalRequestId}/decision`, { method: 'POST', body: { decision: deciding.decision, comment: comment.trim() || undefined } });
      toast(deciding.decision === 'approve' ? `Approved for ${deciding.item.requester.fullName}` : `Declined for ${deciding.item.requester.fullName}`);
      setDeciding(null);
      setComment('');
      await inbox.reload();
      window.dispatchEvent(new Event('erp:approvals-changed'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (inbox.loading && !inbox.data) return <Loading />;
  if (inbox.error) return <ErrorNote error={inbox.error} retry={inbox.reload} />;
  if (!inbox.data?.length) return <Empty title="Nothing is waiting for you">New requests from your team will appear here, and you will get an email.</Empty>;

  const now = new Date();
  return (
    <>
      <Panel>
        <ul className="divide-y divide-line">
          {inbox.data.map((i) => {
            const overdue = i.dueAt && new Date(i.dueAt) < now;
            return (
              <li key={i.stepId} className={`px-4 py-4 ${highlight === i.approvalRequestId ? 'bg-peacock-tint/50' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{i.requester.fullName}</span>
                      <Badge tone="indigo">{i.typeLabel}</Badge>
                      {i.onBehalfOfOther && <Badge>As stand-in</Badge>}
                      {overdue && <Badge tone="kumkum">Past time limit</Badge>}
                    </p>
                    <p className="mt-1 text-sm">{i.summary}</p>
                    <p className="mt-1 text-xs text-muted">
                      Sent {relative(i.submittedAt)}{i.requester.designation ? ` · ${i.requester.designation}` : ''}
                      {i.totalSteps > 1 ? ` · step ${i.stepNumber} of ${i.totalSteps}` : ''}
                      {i.dueAt && !overdue ? ` · reply by ${fmtDateTime(i.dueAt)}` : ''}
                    </p>
                    <button type="button" onClick={() => onTrail(i.approvalRequestId)} className="mt-1 text-xs font-medium text-peacock hover:underline">See the full trail</button>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="danger" size="sm" onClick={() => { setDeciding({ item: i, decision: 'reject' }); setComment(''); setError(''); }}>Decline</Button>
                    <Button size="sm" onClick={() => { setDeciding({ item: i, decision: 'approve' }); setComment(''); setError(''); }}>Approve</Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>

      <Dialog open={!!deciding} onClose={() => setDeciding(null)} title={deciding?.decision === 'approve' ? 'Approve this request' : 'Decline this request'}>
        {deciding && (
          <form onSubmit={(e) => { e.preventDefault(); void decide(); }} className="space-y-4">
            <div className="rounded-lg bg-wash px-3 py-2 text-sm"><p className="font-medium">{deciding.item.requester.fullName} · {deciding.item.typeLabel}</p><p className="text-muted">{deciding.item.summary}</p></div>
            <Field label={deciding.decision === 'approve' ? 'Comment (optional)' : 'Why are you declining?'}>
              <Textarea value={comment} onChange={(e) => setComment(e.target.value)} required={deciding.decision === 'reject'} />
            </Field>
            {deciding.item.totalSteps > deciding.item.stepNumber && deciding.decision === 'approve' && <Notice tone="indigo">After you, this goes on to the next approver.</Notice>}
            {error && <Notice tone="kumkum">{error}</Notice>}
            <FormActions>
              <Button variant="secondary" onClick={() => setDeciding(null)}>Back</Button>
              <Button type="submit" busy={busy} variant={deciding.decision === 'approve' ? 'primary' : 'danger'}>{deciding.decision === 'approve' ? 'Approve' : 'Decline'}</Button>
            </FormActions>
          </form>
        )}
      </Dialog>
    </>
  );
}

function History({ onTrail }: { onTrail: (id: string) => void }) {
  const { data, error, loading, reload } = useApi<HistoryItem[]>('/approvals/history');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNote error={error} retry={reload} />;
  if (!data?.length) return <Empty title="No decisions yet">Requests you approve or decline will be listed here.</Empty>;
  return (
    <Panel>
      <ul className="divide-y divide-line">
        {data.map((h, i) => (
          <li key={`${h.approvalRequestId}-${i}`} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2"><span className="font-medium">{h.requesterName}</span><Badge tone="indigo">{REQUEST_TYPE_LABEL[h.type] ?? h.type}</Badge></p>
              <p className="mt-0.5 text-sm">{h.summary}</p>
              {h.comment && <p className="mt-0.5 text-sm text-muted">“{h.comment}”</p>}
              <button type="button" onClick={() => onTrail(h.approvalRequestId)} className="mt-1 text-xs font-medium text-peacock hover:underline">See the full trail</button>
            </div>
            <div className="text-right text-sm">
              <Badge tone={h.decision === 'approved' ? 'peacock' : 'kumkum'}>{h.decision === 'approved' ? 'You approved' : 'You declined'}</Badge>
              <p className="mt-1 text-xs text-muted">{fmtDateTime(h.actedAt)}</p>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function StandIns() {
  const me = useMe();
  const toast = useToast();
  const list = useApi<Delegation[]>('/approvals/delegations');
  const people = useApi<DirectoryPerson[]>('/employees/directory');
  const [form, setForm] = useState({ delegateId: '', fromDate: todayIst(), toDate: todayIst() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/approvals/delegations', { method: 'POST', body: form });
      toast('Stand-in saved');
      setForm({ ...form, delegateId: '' });
      await list.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api(`/approvals/delegations/${id}`, { method: 'DELETE' });
      toast('Stand-in removed');
      await list.reload();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  return (
    <div className="grid gap-8 md:grid-cols-[1fr_1fr]">
      <Section title="Going away?">
        <p className="mb-4 text-sm text-muted">Choose someone to approve in your place for a few days. They will see your waiting requests, and the history shows who decided.</p>
        <form onSubmit={add} className="space-y-4 rounded-xl border border-line bg-surface p-4">
          <Field label="Stand-in">
            <Select required value={form.delegateId} onChange={(e) => setForm({ ...form, delegateId: e.target.value })}>
              <option value="" disabled>Choose a colleague…</option>
              {people.data?.map((p) => <option key={p.id} value={p.id}>{p.fullName}{p.designation ? ` · ${p.designation}` : ''}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From"><Input type="date" required min={todayIst()} value={form.fromDate} onChange={(e) => setForm({ ...form, fromDate: e.target.value, toDate: form.toDate < e.target.value ? e.target.value : form.toDate })} /></Field>
            <Field label="Until"><Input type="date" required min={form.fromDate} value={form.toDate} onChange={(e) => setForm({ ...form, toDate: e.target.value })} /></Field>
          </div>
          {error && <Notice tone="kumkum">{error}</Notice>}
          <Button type="submit" busy={busy}>Save stand-in</Button>
        </form>
      </Section>

      <Section title="Current and upcoming">
        {list.loading && !list.data && <Loading />}
        {list.error && <ErrorNote error={list.error} retry={list.reload} />}
        {list.data?.length === 0 && <Empty title="No stand-ins set">You are the only one who approves your team's requests.</Empty>}
        {list.data && list.data.length > 0 && (
          <Panel><ul className="divide-y divide-line">
            {list.data.map((d) => {
              const mine = d.delegatorId === me.id;
              return (
                <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div>
                    <p className="font-medium">{mine ? `${d.delegateName} approves for you` : `You approve for ${d.delegatorName}`}</p>
                    <p className="text-muted">{fmtRange(d.fromDate, d.toDate)}</p>
                  </div>
                  {mine && <Button size="sm" variant="secondary" onClick={() => void remove(d.id)}>Remove</Button>}
                </li>
              );
            })}
          </ul></Panel>
        )}
      </Section>
    </div>
  );
}
