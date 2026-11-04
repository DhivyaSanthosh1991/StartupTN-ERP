'use client';

import { useState } from 'react';
import { api, errorText, useApi } from '@/lib/api';
import { fmtClock } from '@/lib/dates';
import { Button, Field, Input, Notice, Panel, StatusBadge, Textarea } from './ui';

interface HomeRequest { id: string; status: string; reason: string | null; leftSiteAt: string; travelMinutes: number | null; approvalRequestId: string | null; currentApprover: string | null; lastComment: string | null }
type DutyToday =
  | { onDuty: false }
  | {
      onDuty: true; duty: { id: string; location: string | null; purpose: string }; state: 'not_started' | 'on_site' | 'finished' | 'next_stop' | 'at_office';
      stops: { id: string; location: string; purpose: string | null; meetingTime: string | null; current: boolean }[];
      leftSiteAt: string | null; officeName: string | null;
      estimate: { distanceKm: number; travelMinutes: number; arriveAt: string; officeEnd: string; suggested: boolean } | null;
      request: HomeRequest | null;
    };

const pad = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

/**
 * Shown only on an approved on-duty day. It walks the day: reach the place and check in (that confirms you are
 * there), do the work, check out, then either go back to the office or ask to go straight home.
 * `refreshKey` changes after each punch so the card moves to the next step.
 */
export function DutyCard({ refreshKey }: { refreshKey: string }) {
  const today = useApi<DutyToday>(`/od/today?k=${encodeURIComponent(refreshKey)}`);
  const [asking, setAsking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [stop, setStop] = useState({ location: '', meetingTime: '', purpose: '' });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const d = today.data;
  if (!d || !d.onDuty) return null;

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/od/return-home', { method: 'POST', body: { reason: reason.trim() || undefined } });
      setAsking(false);
      setReason('');
      await today.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function addStop(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/od/stops', { method: 'POST', body: { location: stop.location.trim(), meetingTime: stop.meetingTime || undefined, purpose: stop.purpose.trim() || undefined } });
      setAdding(false);
      setStop({ location: '', meetingTime: '', purpose: '' });
      await today.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(id: string) {
    setBusy(true);
    try {
      await api(`/od/return-home/${id}/cancel`, { method: 'POST' });
      await today.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const current = d.stops.find((x) => x.current);
  const where = current?.location ?? d.duty.location ?? 'your duty location';
  const r = d.request;
  const live = r && (r.status === 'pending' || r.status === 'approved');

  return (
    <Panel className="mt-5 p-5">
      <p className="text-sm text-muted">On duty today</p>
      <p className="font-display text-xl font-semibold">{where}</p>
      <p className="mt-0.5 text-sm text-muted">{current?.purpose ?? d.duty.purpose}</p>
      {d.stops.length > 0 && <p className="mt-1 text-xs text-muted">Today: {[d.duty.location, ...d.stops.map((x) => x.location)].filter(Boolean).join(' → ')}</p>}

      {d.state === 'not_started' && (
        <p className="mt-3 text-sm">When you reach the place, check in above. That confirms you are there: your photo and location are saved against this duty.</p>
      )}
      {d.state === 'on_site' && (
        <p className="mt-3 text-sm">You are checked in at the duty location. When the work is finished, check out above, from the same place.</p>
      )}

      {d.state === 'next_stop' && (
        <p className="mt-3 text-sm">
          Your next meeting is added{current?.meetingTime ? `, to be there by ${pad(current.meetingTime)}` : ''}. When you reach {current?.location}, check in above.
          If your plans change, you can still check in at the office instead.
        </p>
      )}
      {d.state === 'at_office' && (
        <p className="mt-3 text-sm">You are back at the office. Your hours today are the duty time plus the time you work here, so check out above when your day is done.</p>
      )}

      {d.state === 'finished' && (
        <div className="mt-4 space-y-3">
          <p className="text-sm">Duty finished{d.leftSiteAt ? ` at ${fmtClock(d.leftSiteAt)}` : ''}. Where next?</p>
          {d.estimate && (
            <p className="text-sm text-muted">
              {d.officeName} is about {d.estimate.travelMinutes} minutes away ({d.estimate.distanceKm} km in a straight line). You would reach it around {pad(d.estimate.arriveAt)}; the office closes at {pad(d.estimate.officeEnd)}.
            </p>
          )}
          {d.estimate?.suggested && !live && (
            <Notice tone="indigo">By the time you reach the office it would almost be closing. You can ask to go straight home instead.</Notice>
          )}

          {r && (
            <div className="rounded-lg border border-line p-3 text-sm">
              <p className="flex flex-wrap items-center gap-2">Going home directly <StatusBadge status={r.status} /></p>
              {r.status === 'pending' && r.currentApprover && <p className="mt-1 text-muted">With {r.currentApprover}. Until it is approved, please return to the office.</p>}
              {r.status === 'approved' && <p className="mt-1 text-muted">Approved. You can go straight home.</p>}
              {r.status === 'rejected' && <p className="mt-1 text-muted">Not approved{r.lastComment ? `: “${r.lastComment}”` : ''}. Please return to the office, or ask again below.</p>}
              {r.status === 'pending' && <Button size="sm" variant="secondary" className="mt-2" busy={busy} onClick={() => void withdraw(r.id)}>Withdraw</Button>}
            </div>
          )}

          {!live && !asking && !adding && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setAdding(true)}>I have another meeting</Button>
                <Button variant="secondary" onClick={() => setAsking(true)}>Ask to go straight home</Button>
              </div>
              <p className="text-sm text-muted">Or go back to the office and check in there, no request needed. You may have work to do there: the hours at the duty place and at the office are added together.</p>
            </div>
          )}
          {!live && adding && (
            <form onSubmit={addStop} className="space-y-3">
              <Field label="Where is the next meeting?" hint="The venue and city."><Input required minLength={3} value={stop.location} onChange={(e) => setStop({ ...stop, location: e.target.value })} /></Field>
              <Field label="Must be there by (optional)" hint="If it is fixed for a time, say so."><Input type="time" value={stop.meetingTime} onChange={(e) => setStop({ ...stop, meetingTime: e.target.value })} /></Field>
              <Field label="What is it for? (optional)"><Textarea value={stop.purpose} maxLength={300} onChange={(e) => setStop({ ...stop, purpose: e.target.value })} /></Field>
              {error && <Notice tone="kumkum">{error}</Notice>}
              <div className="flex gap-2">
                <Button type="submit" busy={busy}>Add meeting</Button>
                <Button variant="secondary" onClick={() => setAdding(false)}>Not now</Button>
              </div>
            </form>
          )}
          {!live && asking && (
            <form onSubmit={ask} className="space-y-3">
              <Field label="Reason (optional)" hint="Your manager sees when you left the site and how far the office is.">
                <Textarea value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
              </Field>
              {error && <Notice tone="kumkum">{error}</Notice>}
              <div className="flex gap-2">
                <Button type="submit" busy={busy}>Send for approval</Button>
                <Button variant="secondary" onClick={() => setAsking(false)}>Not now</Button>
              </div>
            </form>
          )}
          {live && error && <Notice tone="kumkum">{error}</Notice>}
        </div>
      )}
    </Panel>
  );
}
