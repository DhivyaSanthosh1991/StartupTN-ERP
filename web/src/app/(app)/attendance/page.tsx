'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ApprovalTrail } from '@/components/approval-trail';
import { MonthCalendar } from '@/components/month-calendar';
import { PunchPanel } from '@/components/punch';
import { RequestRow } from '@/components/request-row';
import { Badge, Button, Dialog, Empty, ErrorNote, Field, FormActions, Input, Loading, Notice, PageHeader, Panel, Section, TableWrap, Tabs, Textarea, td, th, useToast } from '@/components/ui';
import { api, errorText, useApi } from '@/lib/api';
import { addDays, fmtClock, fmtDay, fmtHm, fmtMinutes, monthOf, todayIst } from '@/lib/dates';
import { ATTENTION_FLAGS, dayStatusOf, flagLabel } from '@/lib/labels';
import { useSession } from '@/lib/session';
import type { DayStatus, MonthSummary, RegularisationRequest, TodayAttendance } from '@/lib/types';
import { useTab } from '@/lib/use-tab';

type TabId = 'month' | 'corrections' | 'team';

export default function AttendancePage() {
  const { oversees } = useSession();
  const tabs: { id: TabId; label: string }[] = [
    { id: 'month', label: 'My month' },
    { id: 'corrections', label: 'Corrections' },
    ...(oversees ? [{ id: 'team' as const, label: 'My team' }] : []),
  ];
  const [tab, setTab] = useTab<TabId>(['month', 'corrections', 'team'], 'month');
  const [month, setMonth] = useState(monthOf(todayIst()));
  const [correct, setCorrect] = useState<string | null>(null);
  const today = useApi<TodayAttendance>('/attendance/today');
  const corrections = useApi<RegularisationRequest[]>('/attendance/regularisations');

  return (
    <div>
      <PageHeader title="Attendance" description="Check in, review your month, and ask for a correction when a punch is missing or wrong." />
      {today.data && <div className="mb-8"><PunchPanel today={today.data} onChange={() => { void today.reload(); }} /></div>}
      {today.error && !today.data && <ErrorNote error={today.error} retry={today.reload} />}

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'month' && <MonthCalendar month={month} onMonth={setMonth} onCorrect={(d) => setCorrect(d)} />}
      {tab === 'corrections' && <Corrections list={corrections} onNew={() => setCorrect(todayIst())} />}
      {tab === 'team' && oversees && <TeamView />}

      <CorrectionDialog date={correct} onClose={() => setCorrect(null)} onSent={() => { setCorrect(null); setTab('corrections'); void corrections.reload(); }} />
    </div>
  );
}

// ---------------------------------------------------------------- corrections

function Corrections({ list, onNew }: { list: ReturnType<typeof useApi<RegularisationRequest[]>>; onNew: () => void }) {
  const toast = useToast();
  const [trail, setTrail] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function cancel(id: string) {
    setBusy(id);
    try {
      await api(`/attendance/regularisations/${id}/cancel`, { method: 'POST' });
      toast('Correction cancelled');
      await list.reload();
      window.dispatchEvent(new Event('erp:approvals-changed'));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section title="Your correction requests" action={<Button size="sm" onClick={onNew}>New correction</Button>}>
      <p className="mb-4 max-w-prose text-sm text-muted">Forgot to check in or out, or your phone could not get a location? Tell your manager what the times should have been. Once approved, the day is updated.</p>
      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorNote error={list.error} retry={list.reload} />}
      {list.data?.length === 0 && <Empty title="No corrections yet">Corrections you ask for will appear here with their status.</Empty>}
      {list.data && list.data.length > 0 && (
        <Panel><ul className="divide-y divide-line">
          {list.data.map((r) => (
            <RequestRow key={r.id} title={fmtDay(r.workDate)}
              meta={[r.checkInTime && `In ${fmtHm(r.checkInTime)}`, r.checkOutTime && `Out ${fmtHm(r.checkOutTime)}`].filter(Boolean).join(' · ') + ` · ${r.reason}`}
              status={r.status} approver={r.currentApprover} comment={r.lastComment}
              onOpen={r.approvalRequestId ? () => setTrail(r.approvalRequestId) : undefined}
              actions={r.status === 'pending' ? <Button size="sm" variant="secondary" busy={busy === r.id} onClick={() => void cancel(r.id)}>Cancel</Button> : undefined} />
          ))}
        </ul></Panel>
      )}
      <ApprovalTrail approvalRequestId={trail} onClose={() => setTrail(null)} />
    </Section>
  );
}

function CorrectionDialog({ date, onClose, onSent }: { date: string | null; onClose: () => void; onSent: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ workDate: '', checkInTime: '', checkOutTime: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [seen, setSeen] = useState<string | null>(null);

  // Start each opening with the chosen day and an empty form.
  if (date && date !== seen) {
    setSeen(date);
    setForm({ workDate: date, checkInTime: '', checkOutTime: '', reason: '' });
    setError('');
  }
  if (!date && seen) setSeen(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.checkInTime && !form.checkOutTime) return setError('Enter the check-in time, the check-out time, or both.');
    setBusy(true);
    setError('');
    try {
      await api('/attendance/regularisations', {
        method: 'POST',
        body: { workDate: form.workDate, checkInTime: form.checkInTime || undefined, checkOutTime: form.checkOutTime || undefined, reason: form.reason },
      });
      toast('Correction sent for approval');
      window.dispatchEvent(new Event('erp:approvals-changed'));
      onSent();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!date} onClose={onClose} title="Ask for a correction">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Day"><Input type="date" required max={todayIst()} value={form.workDate} onChange={(e) => setForm({ ...form, workDate: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Should have checked in at"><Input type="time" value={form.checkInTime} onChange={(e) => setForm({ ...form, checkInTime: e.target.value })} /></Field>
          <Field label="Should have checked out at"><Input type="time" value={form.checkOutTime} onChange={(e) => setForm({ ...form, checkOutTime: e.target.value })} /></Field>
        </div>
        <Field label="What happened?" hint="For example: phone battery died, was at a partner office all day.">
          <Textarea required minLength={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </Field>
        {error && <Notice tone="kumkum">{error}</Notice>}
        <FormActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" busy={busy}>Send for approval</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

// ----------------------------------------------------------------------- team

interface TeamRow {
  employeeId: string; empCode: string; fullName: string; designation: string | null; department: string | null;
  status: DayStatus | null; firstIn: string | null; lastOut: string | null; workedMinutes: number; late: boolean; flags: string[];
}
interface TeamSummaryRow { employeeId: string; empCode: string; fullName: string; department: string | null; summary: MonthSummary }

function TeamView() {
  const [mode, setMode] = useState<'day' | 'month'>('day');
  const [date, setDate] = useState(todayIst());
  const [month, setMonth] = useState(monthOf(todayIst()));
  const day = useApi<TeamRow[]>(mode === 'day' ? `/attendance/team/day?date=${date}` : null);
  const summary = useApi<TeamSummaryRow[]>(mode === 'month' ? `/attendance/team/summary?month=${month}` : null);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="inline-flex rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="View">
          {(['day', 'month'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${mode === m ? 'bg-peacock text-white' : 'text-ink/80 hover:bg-wash'}`}>{m === 'day' ? 'One day' : 'Whole month'}</button>
          ))}
        </div>
        {mode === 'day' ? (
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day">‹</Button>
            <Input type="date" value={date} max={todayIst()} onChange={(e) => e.target.value && setDate(e.target.value)} className="w-40" aria-label="Day" />
            <Button variant="secondary" size="sm" disabled={date >= todayIst()} onClick={() => setDate(addDays(date, 1))} aria-label="Next day">›</Button>
          </div>
        ) : (
          <Input type="month" value={month} max={monthOf(todayIst())} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-44" aria-label="Month" />
        )}
      </div>

      {mode === 'day' && (
        <>
          {day.loading && !day.data && <Loading />}
          {day.error && <ErrorNote error={day.error} retry={day.reload} />}
          {day.data?.length === 0 && <Empty title="No one to show">Nobody reports to you yet.</Empty>}
          {day.data && day.data.length > 0 && (
            <TableWrap>
              <thead><tr><th className={th}>Name</th><th className={th}>Status</th><th className={th}>In</th><th className={th}>Out</th><th className={th}>Worked</th><th className={th}>Notes</th></tr></thead>
              <tbody>
                {day.data.map((r) => (
                  <tr key={r.employeeId}>
                    <td className={td}><Link href={`/people/${r.employeeId}?tab=attendance`} className="font-medium hover:underline">{r.fullName}</Link><p className="text-xs text-muted">{r.designation ?? r.empCode}</p></td>
                    <td className={td}>{r.status ? <Badge tone={dayStatusOf(r.status, r.flags).tone}>{dayStatusOf(r.status, r.flags).label}</Badge> : <span className="text-muted">{date === todayIst() ? 'Not in yet' : '—'}</span>}</td>
                    <td className={td}>{r.firstIn ? fmtClock(r.firstIn) : '—'}</td>
                    <td className={td}>{r.lastOut ? fmtClock(r.lastOut) : '—'}</td>
                    <td className={td}>{r.workedMinutes ? fmtMinutes(r.workedMinutes) : '—'}</td>
                    <td className={td}>
                      <span className="flex flex-wrap gap-1">
                        {r.late && <Badge tone="marigold">Late</Badge>}
                        {r.flags.filter((f) => ATTENTION_FLAGS.has(f)).map((f) => <Badge key={f} tone="marigold">{flagLabel(f)}</Badge>)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </>
      )}

      {mode === 'month' && (
        <>
          {summary.loading && !summary.data && <Loading />}
          {summary.error && <ErrorNote error={summary.error} retry={summary.reload} />}
          {summary.data && summary.data.length > 0 && (
            <TableWrap>
              <thead><tr><th className={th}>Name</th><th className={th}>Present</th><th className={th}>Absent</th><th className={th}>Leave</th><th className={th}>On duty</th><th className={th}>Late</th><th className={th}>Hours</th></tr></thead>
              <tbody>
                {summary.data.map((r) => (
                  <tr key={r.employeeId}>
                    <td className={td}><Link href={`/people/${r.employeeId}?tab=attendance`} className="font-medium hover:underline">{r.fullName}</Link><p className="text-xs text-muted">{r.department ?? r.empCode}</p></td>
                    <td className={td}>{r.summary.present + r.summary.halfDay * 0.5}</td>
                    <td className={td}>{r.summary.absent || '—'}</td>
                    <td className={td}>{r.summary.leave || '—'}</td>
                    <td className={td}>{r.summary.od || '—'}</td>
                    <td className={td}>{r.summary.late || '—'}</td>
                    <td className={td}>{fmtMinutes(r.summary.workedMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </>
      )}
    </div>
  );
}
