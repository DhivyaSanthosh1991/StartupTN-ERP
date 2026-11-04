'use client';

import { useState } from 'react';
import { ApprovalTrail } from '@/components/approval-trail';
import { KindBadge, RequestRow } from '@/components/request-row';
import { Button, Dialog, Empty, ErrorNote, Field, FormActions, Input, Loading, Notice, PageHeader, Panel, Section, Select, Tabs, Textarea, useToast } from '@/components/ui';
import { api, errorText, useApi } from '@/lib/api';
import { fmtClock, fmtHm, fmtMinutes, fmtRange, monthLabel, todayIst } from '@/lib/dates';
import { useSession } from '@/lib/session';
import type { OdRequest } from '@/lib/types';

interface Quota { month: string; used: number; limit: number; remaining: number; maxMinutes: number }

/** When the person was at the duty location, from their own check-ins that day. */
const siteLine = (r: OdRequest) => {
  const v = r.siteVisits ?? [];
  const inn = v.find((x) => x.type === 'check_in');
  const out = [...v].reverse().find((x) => x.type === 'check_out');
  return inn ? ` · At the site: in ${fmtClock(inn.at)}${out ? `, out ${fmtClock(out.at)}` : ''}` : '';
};

const title = (r: OdRequest) => r.kind === 'od' ? `On duty${r.location ? ` · ${r.location}` : ''}` : `Permission · ${fmtHm(r.fromTime!)}–${fmtHm(r.toTime!)} (${fmtMinutes(r.minutes ?? 0)})`;

export default function DutyPage() {
  const { oversees } = useSession();
  const [tab, setTab] = useState<'mine' | 'team'>('mine');
  const [kind, setKind] = useState<'od' | 'permission' | null>(null);
  const mine = useApi<OdRequest[]>('/od/requests');
  const quota = useApi<Quota>('/od/permission-quota');

  return (
    <div>
      <PageHeader title="On duty and permission"
        description="On duty is for work away from the office. Permission is for a few hours off in a working day."
        actions={<><Button variant="secondary" onClick={() => setKind('permission')}>Ask for permission</Button><Button onClick={() => setKind('od')}>Request on duty</Button></>} />
      {oversees && <Tabs tabs={[{ id: 'mine', label: 'My requests' }, { id: 'team', label: 'My team' }]} value={tab} onChange={setTab} />}

      {tab === 'mine' && (
        <Section>
          {quota.data && (
            <p className="mb-4 text-sm text-muted">
              Permission in {monthLabel(quota.data.month)}: <strong className="text-ink">{quota.data.used} of {quota.data.limit}</strong> used, up to {fmtMinutes(quota.data.maxMinutes)} each.
            </p>
          )}
          <List list={mine} mine onChanged={() => { void mine.reload(); void quota.reload(); }} />
        </Section>
      )}
      {tab === 'team' && oversees && <Team />}

      <RequestDialog kind={kind} quota={quota.data} onClose={() => setKind(null)}
        onDone={() => { setKind(null); void mine.reload(); void quota.reload(); window.dispatchEvent(new Event('erp:approvals-changed')); }} />
    </div>
  );
}

function List({ list, mine, onChanged }: { list: ReturnType<typeof useApi<OdRequest[]>>; mine?: boolean; onChanged?: () => void }) {
  const toast = useToast();
  const [trail, setTrail] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const today = todayIst();

  async function cancel(id: string) {
    setBusy(id);
    try {
      await api(`/od/requests/${id}/cancel`, { method: 'POST' });
      toast('Request cancelled');
      onChanged?.();
      window.dispatchEvent(new Event('erp:approvals-changed'));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorNote error={list.error} retry={list.reload} />;
  if (!list.data?.length) return <Empty title="Nothing here yet">{mine ? 'Your on-duty and permission requests will show here.' : 'No requests match this view.'}</Empty>;

  return (
    <Panel>
      <ul className="divide-y divide-line">
        {list.data.map((r) => (
          <RequestRow key={r.id} who={mine ? undefined : r.employeeName} title={title(r)} meta={`${fmtRange(r.fromDate, r.toDate)} · ${r.purpose}${r.meetingTime ? ` · Be there by ${fmtHm(r.meetingTime)}` : ''}${(r.stops ?? []).length ? ` · Then: ${(r.stops ?? []).map((x) => x.location).join(', ')}` : ''}${siteLine(r)}`}
            status={r.status} approver={r.currentApprover} comment={r.lastComment}
            onOpen={r.approvalRequestId ? () => setTrail(r.approvalRequestId) : undefined}
            actions={mine && (r.status === 'pending' || (r.status === 'approved' && r.fromDate > today))
              ? <Button size="sm" variant="secondary" busy={busy === r.id} onClick={() => void cancel(r.id)}>Cancel</Button> : <KindBadge>{r.kind === 'od' ? 'On duty' : 'Permission'}</KindBadge>} />
        ))}
      </ul>
      <ApprovalTrail approvalRequestId={trail} onClose={() => setTrail(null)} />
    </Panel>
  );
}

function Team() {
  const [status, setStatus] = useState('pending');
  const list = useApi<OdRequest[]>(`/od/requests/team${status ? `?status=${status}` : ''}`);
  return (
    <Section title="Your team's requests" action={
      <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label="Show">
        <option value="pending">Waiting</option><option value="approved">Approved</option><option value="rejected">Declined</option><option value="">All</option>
      </Select>}>
      <List list={list} />
      <p className="mt-3 text-sm text-muted">Decisions are made from <a href="/approvals" className="font-medium text-peacock hover:underline">Approvals</a>.</p>
    </Section>
  );
}

function RequestDialog({ kind, quota, onClose, onDone }: { kind: 'od' | 'permission' | null; quota?: Quota; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ fromDate: '', toDate: '', fromTime: '', toTime: '', location: '', meetingTime: '', purpose: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [seen, setSeen] = useState<string | null>(null);

  if (kind && kind !== seen) {
    setSeen(kind);
    setForm({ fromDate: todayIst(), toDate: todayIst(), fromTime: '', toTime: '', location: '', meetingTime: '', purpose: '' });
    setError('');
  }
  if (!kind && seen) setSeen(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = kind === 'od'
        ? { kind, fromDate: form.fromDate, toDate: form.toDate, location: form.location.trim(), meetingTime: form.meetingTime || undefined, purpose: form.purpose }
        : { kind, fromDate: form.fromDate, fromTime: form.fromTime, toTime: form.toTime, purpose: form.purpose };
      await api('/od/requests', { method: 'POST', body });
      toast(kind === 'od' ? 'On-duty request sent for approval' : 'Permission request sent for approval');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!kind} onClose={onClose} title={kind === 'od' ? 'Request on duty' : 'Ask for permission'}>
      <form onSubmit={submit} className="space-y-4">
        {kind === 'od' ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From"><Input type="date" required value={form.fromDate} onChange={(e) => setForm({ ...form, fromDate: e.target.value, toDate: form.toDate < e.target.value ? e.target.value : form.toDate })} /></Field>
              <Field label="To"><Input type="date" required min={form.fromDate} value={form.toDate} onChange={(e) => setForm({ ...form, toDate: e.target.value })} /></Field>
            </div>
            <Field label="Where is the duty?" hint="The venue and city. On the day you check in there to confirm you have arrived."><Input required minLength={3} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Madurai incubator, Madurai" /></Field>
            <Field label="Must be there by (optional)" hint="If the meeting is fixed for a time, such as 10:30, say so. You can then go straight to the venue without visiting the office first, and you will not be marked late for it."><Input type="time" value={form.meetingTime} onChange={(e) => setForm({ ...form, meetingTime: e.target.value })} /></Field>
            <Field label="Work to be done"><Textarea required minLength={3} value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} /></Field>
            <p className="text-xs text-muted">Whole days only. Weekly offs and holidays in between are skipped.</p>
          </>
        ) : (
          <>
            <Field label="Day"><Input type="date" required value={form.fromDate} onChange={(e) => setForm({ ...form, fromDate: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From"><Input type="time" required value={form.fromTime} onChange={(e) => setForm({ ...form, fromTime: e.target.value })} /></Field>
              <Field label="To"><Input type="time" required value={form.toTime} onChange={(e) => setForm({ ...form, toTime: e.target.value })} /></Field>
            </div>
            <Field label="Reason"><Textarea required minLength={3} value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} /></Field>
            {quota && <p className="text-xs text-muted">You have {quota.remaining} of {quota.limit} permissions left this month, up to {fmtMinutes(quota.maxMinutes)} each.</p>}
          </>
        )}
        {error && <Notice tone="kumkum">{error}</Notice>}
        <FormActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" busy={busy}>Send for approval</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
