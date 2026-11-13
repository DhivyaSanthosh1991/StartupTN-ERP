import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { api, errorText } from './api';
import { Button, Card, Chips, Err, Field, Heading, Page, addDays, istToday, niceDate, statusText, useLoad, validDate } from './kit';
import { Notice, Sheet, s } from './ui';

interface Balance { leaveTypeId: string; name: string; unlimited: boolean; balance: number; available: number; pending: number; allowHalfDay: boolean }
interface LeaveType { id: string; name: string; allowHalfDay: boolean }
interface Req { id: string; leaveTypeName: string; fromDate: string; toDate: string; dayPart: string; days: number; status: string; currentApprover: string | null; lastComment: string | null; reason: string }

const PARTS = [{ value: 'full', label: 'Full day' }, { value: 'first_half', label: 'First half' }, { value: 'second_half', label: 'Second half' }] as const;

export function Leave() {
  const balances = useLoad<Balance[]>('/leave/balances');
  const mine = useLoad<Req[]>('/leave/requests');
  const [applying, setApplying] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  async function cancel(id: string) {
    setError('');
    try {
      await api(`/leave/requests/${id}/cancel`, { method: 'POST', body: {} });
      void mine.reload(); void balances.reload();
    } catch (e) { setError(errorText(e)); }
  }

  return (
    <Page title="Leave" onRefresh={() => { void balances.reload(); void mine.reload(); }} refreshing={balances.loading || mine.loading}>
      <Button title="Apply for leave" onPress={() => { setMsg(''); setApplying(true); }} />
      {msg ? <Notice tone="ok" text={msg} /> : null}
      <Err text={error || balances.error || mine.error} />

      <Heading>Balance</Heading>
      {(balances.data ?? []).map((b) => (
        <Card key={b.leaveTypeId}>
          <Text style={s.body}>{b.name}</Text>
          <Text style={s.muted}>{b.unlimited ? 'No limit' : `${b.available} days available${b.pending ? ` (${b.pending} waiting for approval)` : ''}`}</Text>
        </Card>
      ))}

      <Heading>Your requests</Heading>
      {mine.data && !mine.data.length ? <Text style={s.muted}>No leave requests yet.</Text> : null}
      {(mine.data ?? []).slice(0, 20).map((r) => (
        <Card key={r.id}>
          <Text style={[s.body, { fontWeight: '600' }]}>{r.leaveTypeName}, {r.days} day{r.days === 1 ? '' : 's'}</Text>
          <Text style={s.muted}>{niceDate(r.fromDate)}{r.toDate !== r.fromDate ? ` to ${niceDate(r.toDate)}` : ''}{r.dayPart !== 'full' ? ` (${r.dayPart === 'first_half' ? 'first' : 'second'} half)` : ''}</Text>
          <Text style={s.body}>{statusText(r.status)}{r.status === 'pending' && r.currentApprover ? ` with ${r.currentApprover}` : ''}</Text>
          {r.lastComment ? <Text style={s.muted}>“{r.lastComment}”</Text> : null}
          {r.status === 'pending' ? <Button title="Cancel request" kind="quiet" onPress={() => void cancel(r.id)} /> : null}
        </Card>
      ))}

      <Apply open={applying} balances={balances.data ?? []} onClose={() => setApplying(false)}
        onDone={() => { setApplying(false); setMsg('Leave request sent for approval.'); void mine.reload(); void balances.reload(); }} />
    </Page>
  );
}

function Apply({ open, balances, onClose, onDone }: { open: boolean; balances: Balance[]; onClose: () => void; onDone: () => void }) {
  const types = useLoad<LeaveType[]>(open ? '/leave/types' : null);
  const [typeId, setTypeId] = useState('');
  const [from, setFrom] = useState(istToday());
  const [to, setTo] = useState(istToday());
  const [part, setPart] = useState<'full' | 'first_half' | 'second_half'>('full');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = types.data ?? [];
  const chosen = list.find((t) => t.id === typeId);

  async function send() {
    if (!typeId) return setError('Choose the type of leave.');
    if (!validDate(from) || !validDate(to)) return setError('Write dates as year-month-day, for example 2026-11-20.');
    if (reason.trim().length < 3) return setError('Please give a short reason.');
    setBusy(true);
    setError('');
    try {
      await api('/leave/requests', { method: 'POST', body: { leaveTypeId: typeId, fromDate: from, toDate: part === 'full' ? to : from, dayPart: part, reason: reason.trim() } });
      setReason('');
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} title="Apply for leave">
      <View>
        <Chips label="Type of leave" options={list.map((t) => ({ value: t.id, label: t.name }))} value={typeId} onChange={setTypeId} />
        {chosen?.allowHalfDay ? <Chips label="Day" options={[...PARTS]} value={part} onChange={setPart} /> : null}
        <Field label="From (YYYY-MM-DD)" value={from} onChange={(v) => { setFrom(v); if (part !== 'full') setTo(v); }} />
        {part === 'full' ? <Field label="To (YYYY-MM-DD)" value={to} onChange={setTo} /> : null}
        <Text style={s.muted}>Quick pick: <Text onPress={() => { setFrom(istToday()); setTo(istToday()); }} style={{ color: '#0f6b66' }}>today</Text>  <Text onPress={() => { setFrom(addDays(istToday(), 1)); setTo(addDays(istToday(), 1)); }} style={{ color: '#0f6b66' }}>tomorrow</Text></Text>
        <Field label="Reason" value={reason} onChange={setReason} multiline />
        <Err text={error || types.error} />
        <Button title="Send for approval" onPress={send} busy={busy} />
        <Button title="Close" kind="quiet" onPress={onClose} />
      </View>
    </Sheet>
  );
}
