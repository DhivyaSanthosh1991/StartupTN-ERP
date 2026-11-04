'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { locate, locationProblem } from './punch';
import { Button, Dialog, Notice } from './ui';

interface Check { id: string; askedAt: string; expiresAt: string }

/**
 * Now and then the server asks a checked-in person to confirm where they are. This asks the server once a minute
 * while the portal is open and shows the question when there is one. Answering reads the location once and sends it;
 * the server compares it with the person's work location. It needs no photo.
 */
export function PresenceWatcher() {
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<'ok' | 'outside' | null>(null);
  const [left, setLeft] = useState(0);
  const checkRef = useRef(check);
  checkRef.current = check;

  const poll = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const r = await api<{ check: Check | null }>('/attendance/presence');
      setCheck((prev) => (prev?.id === r.check?.id ? prev : r.check));
    } catch {
      /* the next minute will try again */
    }
  }, []);

  useEffect(() => {
    void poll();
    const t = setInterval(() => void poll(), 60_000);
    const vis = () => void poll();
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [poll]);

  useEffect(() => {
    if (!check) return;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(check.expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [check]);

  async function answer() {
    if (!check) return;
    setBusy(true);
    setError('');
    try {
      const pos = await locate();
      const r = await api<{ status: 'ok' | 'outside' }>(`/attendance/presence/${check.id}`, {
        method: 'POST',
        body: { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracyM: pos.coords.accuracy },
      });
      setResult(r.status);
      setCheck(null);
    } catch (e) {
      setError(locationProblem(e));
    } finally {
      setBusy(false);
    }
  }

  const open = !!check && left > 0;
  return (
    <>
      <Dialog open={open} onClose={() => undefined} title="Are you at your workplace?">
        <div className="space-y-4">
          <p className="text-sm">This is a routine check. Please confirm your location within {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.</p>
          <p className="text-xs text-muted">Your phone shares its location once, only to compare it with your work location. On a break you are not asked. If you miss this one, you will be asked once more shortly.</p>
          {error && <Notice tone="kumkum">{error}</Notice>}
          <Button busy={busy} onClick={() => void answer()}>Yes, I am here</Button>
        </div>
      </Dialog>
      <Dialog open={result !== null} onClose={() => setResult(null)} title={result === 'ok' ? 'Thank you' : 'Noted'}>
        <div className="space-y-4">
          <p className="text-sm">
            {result === 'ok'
              ? 'Your location matches your workplace.'
              : 'You are outside your work location. This is noted for HR. If you are out on work, apply for on duty in advance, or switch to break mode when you step out.'}
          </p>
          <Button onClick={() => setResult(null)}>Close</Button>
        </div>
      </Dialog>
    </>
  );
}
