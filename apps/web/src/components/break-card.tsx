'use client';

import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { fmtClock, fmtMinutes } from '@/lib/dates';
import type { BreakState, TodayAttendance } from '@/lib/types';
import { Button, Notice, Panel } from './ui';

/**
 * Stepping out during the day. "Out for lunch" starts the break and "I'm back" ends it; the server notes the
 * times. Break time is working time, so nothing is deducted and nothing is flagged. Random location checks
 * do not come while someone is on a break.
 */
export function BreakCard({ today }: { today: TodayAttendance }) {
  const [state, setState] = useState<BreakState | undefined>(today.breaks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setState(today.breaks), [today.breaks]);
  useEffect(() => {
    if (!state?.onBreak) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [state?.onBreak]);

  if (!state) return null;
  if (today.state !== 'checked_in' && !state.onBreak) return null;

  async function go(path: 'start' | 'end', kind?: 'lunch' | 'other') {
    setBusy(true);
    setError('');
    try {
      setState(await api<BreakState>(`/attendance/break/${path}`, { method: 'POST', body: kind ? { kind } : {} }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const away = state.onBreak ? Math.max(0, Math.round((now - new Date(state.onBreak.since).getTime()) / 60_000)) : 0;

  return (
    <Panel className="mt-5 p-5">
      {state.onBreak ? (
        <div className="space-y-3">
          <p className="font-display text-xl font-semibold">{state.onBreak.kind === 'lunch' ? 'Out for lunch' : 'On a break'}</p>
          <p className="text-sm text-muted">
            Since {fmtClock(state.onBreak.since)}, {fmtMinutes(away)} so far. Break time counts as working time. When you are back at work, confirm it below.
          </p>
          {error && <Notice tone="kumkum">{error}</Notice>}
          <Button busy={busy} onClick={() => void go('end')}>I am back at work</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">Stepping out, for lunch or anything else? Switch to break mode. It counts as working time.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" busy={busy} onClick={() => void go('start', 'lunch')}>Out for lunch</Button>
            <Button variant="secondary" busy={busy} onClick={() => void go('start', 'other')}>Other break</Button>
          </div>
          {state.usedMinutes > 0 && (
            <p className="text-sm text-muted">Breaks today: {fmtMinutes(state.usedMinutes)}.</p>
          )}
          {error && <Notice tone="kumkum">{error}</Notice>}
        </div>
      )}
    </Panel>
  );
}
