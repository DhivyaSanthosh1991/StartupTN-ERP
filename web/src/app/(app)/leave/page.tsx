'use client';

import { useState } from 'react';
import { ApprovalTrail } from '@/components/approval-trail';
import { BalanceList } from '@/components/balances';
import { RequestRow } from '@/components/request-row';
import { Button, Dialog, Empty, ErrorNote, Field, FormActions, Input, Loading, Notice, PageHeader, Panel, Section, Select, Tabs, Textarea, useToast } from '@/components/ui';
import { api, errorText, useApi } from '@/lib/api';
import { fmtDays, fmtRange, todayIst } from '@/lib/dates';
import { DAY_PART } from '@/lib/labels';
import { useSession } from '@/lib/session';
import type { LeaveBalance, LeaveRequest } from '@/lib/types';

interface LeaveType { id: string; code: string; name: string; allowHalfDay: boolean; paid: boolean; requiresDocumentAfterDays: number | null }

export default function LeavePage() {
  const { oversees } = useSession();
  const [tab, setTab] = useState<'mine' | 'team'>('mine');
  const [applying, setApplying] = useState(false);
  const balances = useApi<LeaveBalance[]>('/leave/balances');
  const mine = useApi<LeaveRequest[]>('/leave/requests');

  return (
    <div>
      <PageHeader title="Leave" description="See what you have left, apply, and follow your requests."
        actions={<Button onClick={() => setApplying(true)}>Apply for leave</Button>} />
      {oversees && <Tabs tabs={[{ id: 'mine', label: 'My leave' }, { id: 'team', label: 'My team' }]} value={tab} onChange={setTab} />}

      {tab === 'mine' && (
        <>
          <Section title="Balance">
            {balances.loading && !balances.data && <Loading />}
            {balances.error && <ErrorNote error={balances.error} retry={balances.reload} />}
            {balances.data && <BalanceList balances={balances.data} />}
          </Section>
          <Section title="Your requests"><MyRequests list={mine} onChanged={() => { void mine.reload(); void balances.reload(); }} /></Section>
        </>
      )}
      {tab === 'team' && oversees && <TeamLeave />}

      <ApplyDialog open={applying} balances={balances.data ?? []} onClose={() => setApplying(false)}
        onDone={() => { setApplying(false); void mine.reload(); void balances.reload(); window.dispatchEvent(new Event('erp:approvals-changed')); }} />
    </div>
  );
}

function MyRequests({ list, onChanged }: { list: ReturnType<typeof useApi<LeaveRequest[]>>; onChanged: () => void }) {
  const toast = useToast();
  const [trail, setTrail] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const today = todayIst();

  async function cancel(id: string) {
    setBusy(id);
    try {
      await api(`/leave/requests/${id}/cancel`, { method: 'POST' });
      toast('Leave cancelled. Your balance is restored.');
      onChanged();
      window.dispatchEvent(new Event('erp:approvals-changed'));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorNote error={list.error} retry={list.reload} />;
  if (!list.data?.length) return <Empty title="No leave requests this year">When you apply, your requests and their status will show here.</Empty>;

  return (
    <Panel>
      <ul className="divide-y divide-line">
        {list.data.map((r) => (
          <RequestRow key={r.id} title={`${r.leaveTypeName} · ${fmtDays(r.days)}`}
            meta={`${fmtRange(r.fromDate, r.toDate)}${r.dayPart !== 'full' ? `, ${DAY_PART[r.dayPart].toLowerCase()}` : ''} · ${r.reason}`}
            status={r.status} approver={r.currentApprover} comment={r.lastComment}
            onOpen={r.approvalRequestId ? () => setTrail(r.approvalRequestId) : undefined}
            actions={(r.status === 'pending' || (r.status === 'approved' && r.fromDate > today))
              ? <Button size="sm" variant="secondary" busy={busy === r.id} onClick={() => void cancel(r.id)}>Cancel</Button> : undefined} />
        ))}
      </ul>
      <ApprovalTrail approvalRequestId={trail} onClose={() => setTrail(null)} />
    </Panel>
  );
}

function ApplyDialog({ open, balances, onClose, onDone }: { open: boolean; balances: LeaveBalance[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const types = useApi<LeaveType[]>(open ? '/leave/types' : null);
  const [form, setForm] = useState({ leaveTypeId: '', fromDate: '', toDate: '', dayPart: 'full', reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wasOpen, setWasOpen] = useState(false);

  if (open && !wasOpen) {
    setWasOpen(true);
    setForm({ leaveTypeId: '', fromDate: todayIst(), toDate: todayIst(), dayPart: 'full', reason: '' });
    setError('');
  }
  if (!open && wasOpen) setWasOpen(false);

  const type = types.data?.find((t) => t.id === form.leaveTypeId);
  const balance = balances.find((b) => b.leaveTypeId === form.leaveTypeId);
  const half = form.dayPart !== 'full';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/leave/requests', { method: 'POST', body: { ...form, toDate: half ? form.fromDate : form.toDate } });
      toast('Leave request sent for approval');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Apply for leave">
      {types.loading && !types.data ? <Loading /> : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Type of leave" hint={balance && !balance.unlimited ? `${balance.available} available${balance.pending ? `, ${balance.pending} more waiting for approval` : ''}` : type && !type.paid ? 'Unpaid leave has no limit.' : undefined}>
            <Select required value={form.leaveTypeId} onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value, dayPart: 'full' })}>
              <option value="" disabled>Choose…</option>
              {types.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          {type?.allowHalfDay && (
            <Field label="How much of the day">
              <Select value={form.dayPart} onChange={(e) => setForm({ ...form, dayPart: e.target.value })}>
                <option value="full">Full day(s)</option>
                <option value="first_half">First half only</option>
                <option value="second_half">Second half only</option>
              </Select>
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label={half ? 'Day' : 'From'}><Input type="date" required value={form.fromDate} onChange={(e) => setForm({ ...form, fromDate: e.target.value, toDate: form.toDate < e.target.value ? e.target.value : form.toDate })} /></Field>
            {!half && <Field label="To"><Input type="date" required min={form.fromDate} value={form.toDate} onChange={(e) => setForm({ ...form, toDate: e.target.value })} /></Field>}
          </div>
          <Field label="Reason" hint={type?.requiresDocumentAfterDays ? `Keep a supporting document ready if you take more than ${type.requiresDocumentAfterDays} days. HR may ask for it.` : undefined}>
            <Textarea required minLength={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Field>
          <p className="text-xs text-muted">Weekly offs and holidays inside the dates are not counted.</p>
          {error && <Notice tone="kumkum">{error}</Notice>}
          <FormActions>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" busy={busy}>Send for approval</Button>
          </FormActions>
        </form>
      )}
    </Dialog>
  );
}

function TeamLeave() {
  const [status, setStatus] = useState('pending');
  const list = useApi<LeaveRequest[]>(`/leave/requests/team${status ? `?status=${status}` : ''}`);
  const [trail, setTrail] = useState<string | null>(null);
  return (
    <Section title="Your team's leave" action={
      <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label="Show">
        <option value="pending">Waiting</option><option value="approved">Approved</option><option value="rejected">Declined</option><option value="">All</option>
      </Select>}>
      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorNote error={list.error} retry={list.reload} />}
      {list.data?.length === 0 && <Empty title="Nothing here">No leave requests match this view.</Empty>}
      {list.data && list.data.length > 0 && (
        <Panel><ul className="divide-y divide-line">
          {list.data.map((r) => (
            <RequestRow key={r.id} who={r.employeeName} title={`${r.leaveTypeName} · ${fmtDays(r.days)}`}
              meta={`${fmtRange(r.fromDate, r.toDate)}${r.dayPart !== 'full' ? `, ${DAY_PART[r.dayPart].toLowerCase()}` : ''} · ${r.reason}`}
              status={r.status} approver={r.currentApprover} comment={r.lastComment}
              onOpen={r.approvalRequestId ? () => setTrail(r.approvalRequestId) : undefined} />
          ))}
        </ul></Panel>
      )}
      <p className="mt-3 text-sm text-muted">Decisions are made from <a href="/approvals" className="font-medium text-peacock hover:underline">Approvals</a>.</p>
      <ApprovalTrail approvalRequestId={trail} onClose={() => setTrail(null)} />
    </Section>
  );
}
