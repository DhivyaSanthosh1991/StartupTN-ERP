'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { Button, Dialog, Field, Notice, Textarea, cx } from './ui';

interface TrackState {
  enabled: boolean;
  active: boolean;
  intervalMinutes: number;
  away: { id: string; leftAt: string; explained: boolean } | null;
}

const KINDS = [
  { value: 'official', label: 'On official work' },
  { value: 'break', label: 'Taking a break' },
  { value: 'personal', label: 'Personal errand' },
  { value: 'other', label: 'Something else' },
] as const;

/**
 * While someone is checked in (and not on a break) the portal sends one coarse location reading every few minutes.
 * It uses the phone's network location, not the GPS chip, and does nothing while the screen is off, so the
 * battery is hardly touched. A small note shows on screen the whole time it is on.
 * If the server finds the person outside their work location without a reason, they are asked what is happening.
 */
export function LocationSharing() {
  const [state, setState] = useState<TrackState | null>(null);
  const [problem, setProblem] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]['value']>('official');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hiddenUntil, setHiddenUntil] = useState(0);
  const lastSent = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const fetchState = useCallback(async () => {
    try {
      setState(await api<TrackState>('/attendance/track'));
    } catch {
      /* the next minute will try again */
    }
  }, []);

  const send = useCallback(async () => {
    const s = stateRef.current;
    if (!s?.active || !navigator.geolocation) return;
    lastSent.current = Date.now();
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        // Network location, a reading up to two minutes old is fine: this is what keeps the battery use tiny.
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, maximumAge: 120_000, timeout: 20_000 }));
      setProblem('');
      const r = await api<TrackState>('/attendance/track', {
        method: 'POST',
        body: { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracyM: pos.coords.accuracy },
      });
      setState(r);
    } catch (e) {
      const code = (e as { code?: number })?.code;
      if (code === 1) setProblem('Location is switched off for this site. Turn it on in your browser so your day is counted.');
    }
  }, []);

  // Once a minute: ask whether sharing is on, and send a reading when one is due.
  useEffect(() => {
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      await fetchState();
      const s = stateRef.current;
      if (s?.active && Date.now() - lastSent.current >= s.intervalMinutes * 60_000 - 5_000) await send();
    };
    void tick();
    const t = setInterval(() => void tick(), 60_000);
    const vis = () => void tick();
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [fetchState, send]);

  async function explain(e: React.FormEvent) {
    e.preventDefault();
    if (!state?.away) return;
    setBusy(true);
    setError('');
    try {
      setState(await api<TrackState>(`/attendance/track/alerts/${state.away.id}`, { method: 'POST', body: { kind, note: note.trim() || undefined } }));
      setNote('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const asking = !!state?.away && !state.away.explained && Date.now() > hiddenUntil;
  return (
    <>
      {state?.active && (
        <p className={cx('fixed bottom-3 right-3 z-30 max-w-[16rem] rounded-full border px-3 py-1 text-xs shadow-sm print:hidden', problem ? 'border-marigold bg-marigold-tint text-marigold-ink' : 'border-line bg-surface text-muted')} role="status">
          {problem || 'Sharing your location until you check out'}
        </p>
      )}
      <Dialog open={asking} onClose={() => setHiddenUntil(Date.now() + 10 * 60_000)} title="You seem to be away from the office">
        <form onSubmit={explain} className="space-y-4">
          <p className="text-sm">Your phone shows you outside your work location. Please say why, so it is on record.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {KINDS.map((k) => (
              <label key={k.value} className={cx('flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm', kind === k.value ? 'border-peacock bg-peacock/5' : 'border-line')}>
                <input type="radio" name="away-kind" checked={kind === k.value} onChange={() => setKind(k.value)} className="accent-peacock" />
                {k.label}
              </label>
            ))}
          </div>
          {(kind === 'official' || kind === 'other') && (
            <Field label="Where are you, and what for?"><Textarea required maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          )}
          {kind === 'break' && <p className="text-xs text-muted">This also switches you to break mode. Tap “I am back at work” on the home screen when you return.</p>}
          {error && <Notice tone="kumkum">{error}</Notice>}
          <div className="flex gap-2">
            <Button type="submit" busy={busy}>Send</Button>
            <Button type="button" variant="secondary" onClick={() => setHiddenUntil(Date.now() + 10 * 60_000)}>Ask me later</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
