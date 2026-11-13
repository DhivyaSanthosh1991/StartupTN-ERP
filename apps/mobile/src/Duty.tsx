import React, { useState } from 'react';
import { Text } from 'react-native';
import { api, errorText } from './api';
import { Button, Card, Chips, Err, Field, Heading, Page, istToday, niceDate, statusText, useLoad, validDate, validTime } from './kit';
import { Notice, s } from './ui';

type DutyToday =
  | { onDuty: false }
  | {
      onDuty: true; duty: { id: string; location: string | null; purpose: string }; state: 'not_started' | 'on_site' | 'finished' | 'next_stop' | 'at_office';
      stops: { id: string; location: string; purpose: string | null; meetingTime: string | null; current: boolean }[];
      leftSiteAt: string | null; officeName: string | null;
      estimate: { distanceKm: number; travelMinutes: number; arriveAt: string } | null;
      request: { id: string; status: string; lastComment: string | null } | null;
    };
interface OdReq { id: string; kind: 'od' | 'permission'; fromDate: string; toDate: string; fromTime: string | null; toTime: string | null; location: string | null; purpose: string; status: string; currentApprover: string | null; lastComment: string | null }

const STATE_TEXT: Record<string, string> = {
  not_started: 'Reach the place, then check in from the Today tab. That confirms you are there.',
  on_site: 'You are at the duty location. Check out from the Today tab when you finish.',
  finished: 'Work done. Go back to the office, or ask to go straight home below.',
  next_stop: 'On the way to your next meeting. Check in from the Today tab when you arrive.',
  at_office: 'You are back at the office.',
};

export function Duty() {
  const today = useLoad<DutyToday>('/od/today');
  const mine = useLoad<OdReq[]>('/od/requests');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'' | 'od' | 'permission' | 'stop' | 'home'>('');

  const refresh = () => { void today.reload(); void mine.reload(); };
  const d = today.data;

  async function cancel(path: string) {
    setError('');
    try { await api(path, { method: 'POST', body: {} }); refresh(); } catch (e) { setError(errorText(e)); }
  }

  return (
    <Page title="On duty" onRefresh={refresh} refreshing={today.loading || mine.loading}>
      <Err text={error || today.error || mine.error} />

      {d && d.onDuty ? (
        <Card>
          <Text style={[s.body, { fontWeight: '700' }]}>On duty today: {d.duty.location ?? d.duty.purpose}</Text>
          <Text style={s.body}>{STATE_TEXT[d.state]}</Text>
          {d.stops.map((st) => (
            <Text key={st.id} style={s.muted}>{st.current ? '● ' : '○ '}{st.location}{st.meetingTime ? `, ${st.meetingTime}` : ''}</Text>
          ))}
          {d.estimate ? <Text style={s.muted}>About {d.estimate.travelMinutes} minutes to the office.</Text> : null}
          {d.request ? <Notice text={`Go-home request: ${statusText(d.request.status)}`} /> : null}
          <Button title="I have another meeting" kind="quiet" onPress={() => setMode(mode === 'stop' ? '' : 'stop')} />
          {d.state === 'finished' && !d.request ? <Button title="Ask to go home" kind="quiet" onPress={() => setMode(mode === 'home' ? '' : 'home')} /> : null}
          {d.request?.status === 'pending' ? <Button title="Cancel go-home request" kind="quiet" onPress={() => void cancel(`/od/return-home/${d.request!.id}/cancel`)} /> : null}
          {mode === 'stop' ? <StopForm onDone={() => { setMode(''); refresh(); }} /> : null}
          {mode === 'home' ? <HomeForm onDone={() => { setMode(''); refresh(); }} /> : null}
        </Card>
      ) : d ? <Text style={s.muted}>You are not on an approved duty today.</Text> : null}

      <Heading>New request</Heading>
      <Chips options={[{ value: 'od', label: 'On-duty (outside work)' }, { value: 'permission', label: 'Permission (hours)' }]} value={mode === 'od' || mode === 'permission' ? mode : ''} onChange={(v) => setMode(v)} />
      {mode === 'od' ? <OdForm onDone={() => { setMode(''); refresh(); }} /> : null}
      {mode === 'permission' ? <PermissionForm onDone={() => { setMode(''); refresh(); }} /> : null}

      <Heading>Your requests</Heading>
      {mine.data && !mine.data.length ? <Text style={s.muted}>Nothing yet.</Text> : null}
      {(mine.data ?? []).slice(0, 20).map((r) => (
        <Card key={r.id}>
          <Text style={[s.body, { fontWeight: '600' }]}>{r.kind === 'od' ? 'On duty' : 'Permission'}: {r.location ?? r.purpose}</Text>
          <Text style={s.muted}>{niceDate(r.fromDate)}{r.toDate !== r.fromDate ? ` to ${niceDate(r.toDate)}` : ''}{r.fromTime ? `, ${r.fromTime} to ${r.toTime}` : ''}</Text>
          <Text style={s.body}>{statusText(r.status)}{r.status === 'pending' && r.currentApprover ? ` with ${r.currentApprover}` : ''}</Text>
          {r.lastComment ? <Text style={s.muted}>“{r.lastComment}”</Text> : null}
          {r.status === 'pending' ? <Button title="Cancel request" kind="quiet" onPress={() => void cancel(`/od/requests/${r.id}/cancel`)} /> : null}
        </Card>
      ))}
    </Page>
  );
}

function useSubmit(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(path: string, body: unknown) {
    setBusy(true);
    setError('');
    try { await api(path, { method: 'POST', body }); onDone(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return { busy, error, setError, run };
}

function OdForm({ onDone }: { onDone: () => void }) {
  const [from, setFrom] = useState(istToday());
  const [to, setTo] = useState(istToday());
  const [place, setPlace] = useState('');
  const [time, setTime] = useState('');
  const [purpose, setPurpose] = useState('');
  const f = useSubmit(onDone);
  return (
    <Card>
      <Field label="From (YYYY-MM-DD)" value={from} onChange={setFrom} />
      <Field label="To (YYYY-MM-DD)" value={to} onChange={setTo} />
      <Field label="Where (venue and city)" value={place} onChange={setPlace} />
      <Field label="Must be there by (HH:MM, optional)" value={time} onChange={setTime} placeholder="10:30" />
      <Field label="What is the work" value={purpose} onChange={setPurpose} multiline />
      <Err text={f.error} />
      <Button title="Send for approval" busy={f.busy} onPress={() => {
        if (!validDate(from) || !validDate(to)) return f.setError('Write dates as year-month-day, for example 2026-11-20.');
        if (time && !validTime(time)) return f.setError('Write the time as HH:MM, for example 10:30.');
        void f.run('/od/requests', { kind: 'od', fromDate: from, toDate: to, location: place.trim(), meetingTime: time || undefined, purpose: purpose.trim() });
      }} />
    </Card>
  );
}

function PermissionForm({ onDone }: { onDone: () => void }) {
  const [date, setDate] = useState(istToday());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [purpose, setPurpose] = useState('');
  const f = useSubmit(onDone);
  return (
    <Card>
      <Field label="Date (YYYY-MM-DD)" value={date} onChange={setDate} />
      <Field label="From (HH:MM)" value={from} onChange={setFrom} placeholder="15:00" />
      <Field label="To (HH:MM)" value={to} onChange={setTo} placeholder="16:30" />
      <Field label="Reason" value={purpose} onChange={setPurpose} multiline />
      <Err text={f.error} />
      <Button title="Send for approval" busy={f.busy} onPress={() => {
        if (!validDate(date)) return f.setError('Write the date as year-month-day, for example 2026-11-20.');
        if (!validTime(from) || !validTime(to)) return f.setError('Write times as HH:MM, for example 15:00.');
        void f.run('/od/requests', { kind: 'permission', fromDate: date, fromTime: from, toTime: to, purpose: purpose.trim() });
      }} />
    </Card>
  );
}

function StopForm({ onDone }: { onDone: () => void }) {
  const [place, setPlace] = useState('');
  const [time, setTime] = useState('');
  const [purpose, setPurpose] = useState('');
  const f = useSubmit(onDone);
  return (
    <>
      <Field label="Next meeting (venue and city)" value={place} onChange={setPlace} />
      <Field label="Must be there by (HH:MM, optional)" value={time} onChange={setTime} />
      <Field label="What for (optional)" value={purpose} onChange={setPurpose} />
      <Err text={f.error} />
      <Button title="Add this meeting" busy={f.busy} onPress={() => {
        if (time && !validTime(time)) return f.setError('Write the time as HH:MM, for example 14:30.');
        void f.run('/od/stops', { location: place.trim(), meetingTime: time || undefined, purpose: purpose.trim() || undefined });
      }} />
    </>
  );
}

function HomeForm({ onDone }: { onDone: () => void }) {
  const [reason, setReason] = useState('');
  const f = useSubmit(onDone);
  return (
    <>
      <Field label="Reason (optional)" value={reason} onChange={setReason} />
      <Err text={f.error} />
      <Button title="Send to my approver" busy={f.busy} onPress={() => void f.run('/od/return-home', { reason: reason.trim() || undefined })} />
    </>
  );
}
