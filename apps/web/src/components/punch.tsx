'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, errorText } from '@/lib/api';
import { fmtClock, fmtClockSeconds, fmtMinutes } from '@/lib/dates';
import { SOURCE_LABEL, flagLabel } from '@/lib/labels';
import { useSession } from '@/lib/session';
import type { PunchEvent, TodayAttendance } from '@/lib/types';
import { Capture, SelfieCapture, SelfieThumb } from './selfie';
import { Badge, Button, Dialog, FormActions, Notice, cx } from './ui';

export function locate(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('This browser cannot share a location.'));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 });
  });
}

export function locationProblem(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  const code = (e as GeolocationPositionError | undefined)?.code;
  if (code === 1) return 'Location is blocked for this site. Allow location in your browser settings, then try again.';
  if (code === 2) return 'Your device could not work out where you are. Move to an open area or turn on location services, then try again.';
  if (code === 3) return 'Finding your location took too long. Try again.';
  return errorText(e);
}

/**
 * The check-in / check-out control: a clock that fills as the day's hours add up, the one button
 * that matters, and the punches recorded today. Pressing the button opens the selfie screen, which takes
 * the photo and reads the location in the same moment (or, when HR has switched selfies off, reads the
 * location alone). Nothing is read before the button is pressed.
 */
export function PunchPanel({ today, onChange }: { today: TodayAttendance; onChange: (t: TodayAttendance) => void }) {
  const { refresh } = useSession();
  const [now, setNow] = useState(() => new Date());
  const [phase, setPhase] = useState<'idle' | 'consent' | 'capture' | 'locating' | 'saving'>('idle');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [pending, setPending] = useState<'check-in' | 'check-out'>('check-in');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ flags: string[]; kind: 'check-in' | 'check-out' } | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const worked = useMemo(() => {
    const closed = today.day?.workedMinutes ?? 0;
    const open = today.openSince ? Math.max(0, Math.floor((now.getTime() - new Date(today.openSince).getTime()) / 60_000)) : 0;
    return closed + open;
  }, [today, now]);

  const target = today.rules.fullDayMinutes;
  const fraction = Math.min(worked / target, 1);
  const R = 92;
  const C = 2 * Math.PI * R;
  const [hh, mm, ss] = fmtClockSeconds(now).split(':');
  const action: 'check-in' | 'check-out' = today.canCheckOut ? 'check-out' : 'check-in';
  const busy = phase === 'locating' || phase === 'saving';

  const needsConsent = !today.locationConsent || (today.selfieRequired && !today.photoConsent);

  function finish(next: TodayAttendance, kind: 'check-in' | 'check-out') {
    const last = [...next.events].reverse().find((e) => e.type === (kind === 'check-in' ? 'check_in' : 'check_out'));
    setResult({ kind, flags: last?.flags ?? [] });
    onChange(next);
  }

  async function run(kind: 'check-in' | 'check-out', justConsented = false) {
    setError('');
    setResult(null);
    setPending(kind);
    if (needsConsent && !justConsented) return setPhase('consent');
    if (today.selfieRequired) return setPhase('capture');
    try {
      setPhase('locating');
      const pos = await locate();
      setPhase('saving');
      finish(await api<TodayAttendance>(`/attendance/${kind}`, {
        method: 'POST',
        body: { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracyM: pos.coords.accuracy, source: 'web' },
      }), kind);
    } catch (e) {
      setError(locationProblem(e));
    } finally {
      setPhase('idle');
    }
  }

  /** Called by the selfie screen with the photo and the location it read at the same moment. */
  async function submitCapture(c: Capture) {
    const kind = pending;
    try {
      const next = await api<TodayAttendance>(`/attendance/${kind}`, {
        method: 'POST',
        body: { latitude: c.latitude, longitude: c.longitude, accuracyM: c.accuracyM, selfie: c.selfie, source: 'web' },
      });
      finish(next, kind);
      setPhase('idle');
    } catch (e) {
      // If the person closed the screen while this was saving, there is nowhere inside it to show the problem.
      if (phaseRef.current !== 'capture') setError(errorText(e));
      throw e;
    }
  }

  async function accept() {
    try {
      if (!today.locationConsent) await api('/me/location-consent', { method: 'POST' });
      if (today.selfieRequired && !today.photoConsent) await api('/me/photo-consent', { method: 'POST' });
      await refresh();
      onChange({ ...today, locationConsent: true, photoConsent: today.selfieRequired ? true : today.photoConsent });
      // Continue straight into the punch the person asked for.
      await run(pending, true);
    } catch (e) {
      setError(errorText(e));
      setPhase('idle');
    }
  }

  const info = today.info;
  const banner = info.holiday
    ? `Today is a holiday: ${info.holiday}.`
    : info.weeklyOff ? 'Today is a weekly off.'
    : info.leave ? (info.leave === 'full' ? 'You are on leave today.' : 'You have half-day leave today.')
    : info.od ? (today.selfieRequired ? 'You are on duty today. Check in and out here with a selfie, so your manager can see where you were.' : 'You are on duty today. Check in and out here.') : '';

  const status = today.state === 'checked_in' && today.openSince
    ? `In since ${fmtClock(today.openSince)}`
    : today.state === 'checked_out' ? 'Checked out' : 'Not checked in yet';

  return (
    <div className="rounded-2xl border border-line bg-surface p-5 sm:p-7">
      <div className="grid items-center gap-6 md:grid-cols-[216px_1fr] md:gap-8">
        <div className="relative mx-auto size-[216px]" role="img" aria-label={`${fmtMinutes(worked)} worked of ${fmtMinutes(target)}`}>
          <svg viewBox="0 0 216 216" className="absolute inset-0 -rotate-90">
            <circle cx="108" cy="108" r={R} fill="none" stroke="var(--color-wash)" strokeWidth="10" />
            <circle cx="108" cy="108" r={R} fill="none" stroke="var(--color-peacock)" strokeWidth="10" strokeLinecap="round"
              strokeDasharray={C} strokeDashoffset={C * (1 - fraction)} style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <p className="font-display text-[44px] font-semibold leading-none tracking-tight">
              {hh}:{mm}<span className="ml-1 align-top text-base font-medium text-muted">{ss}</span>
            </p>
            <p className="mt-2 text-xs text-muted">India time</p>
            <p className="mt-3 text-sm font-medium">{worked > 0 ? `${fmtMinutes(worked)} worked` : 'No hours yet'}</p>
          </div>
        </div>

        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            {today.state === 'checked_in' && <span className="live-dot size-2 rounded-full bg-peacock" aria-hidden="true" />}
            {status}
            {today.day?.late && <Badge tone="marigold">Late</Badge>}
          </p>
          {banner && <p className="mt-1 text-sm text-muted">{banner}</p>}

          {today.canPunch ? (
            <>
              <Button size="lg" busy={busy} onClick={() => void run(action)} className="mt-4 w-full sm:w-auto sm:min-w-52"
                variant={action === 'check-out' ? 'secondary' : 'primary'}>
                {phase === 'locating' ? 'Finding your location' : phase === 'saving' ? 'Saving' : action === 'check-in' ? 'Check in' : 'Check out'}
              </Button>
              <p className="mt-2 text-xs text-muted">
                {today.selfieRequired
                  ? 'Pressing this opens your camera and reads your location, to take a selfie. Nothing is recorded before that.'
                  : 'Your location is read only when you press this button.'}
              </p>
            </>
          ) : (
            <p className="mt-3 max-w-prose rounded-lg bg-wash px-3 py-2.5 text-sm text-muted">
              Your attendance is recorded by the biometric machine at head office, so there is nothing to press here.
              If you are away from the office on work, ask for <span className="font-medium text-ink">On duty</span> first; on that day you check in here with a selfie.
            </p>
          )}

          <div className="mt-3 space-y-2" aria-live="polite">
            {error && <Notice tone="kumkum">{error}</Notice>}
            {result && !error && (
              <Notice tone={result.flags.some((f) => f === 'outside_geofence' || f === 'impossible_travel') ? 'marigold' : 'peacock'}>
                {result.kind === 'check-in' ? 'You are checked in.' : 'You are checked out.'}
                {result.flags.filter((f) => f !== 'regularised').map((f) => ` ${flagLabel(f)}.`).join('')}
                {result.flags.includes('outside_geofence') && ' Your manager and HR can see this. If you were working, you can ask for a correction.'}
              </Notice>
            )}
          </div>
        </div>
      </div>

      {today.events.length > 0 && <EventList events={today.events} />}

      {phase === 'capture' && <SelfieCapture kind={pending} onCancel={() => setPhase('idle')} onSubmit={submitCapture} />}

      <Dialog open={phase === 'consent'} onClose={() => { if (phaseRef.current === 'consent') setPhase('idle'); }} title="Before you check in">
        <div className="space-y-3 text-sm">
          {today.selfieRequired
            ? <p>StartupTN records a selfie and where you are at the moment you check in and check out, to confirm attendance.</p>
            : <p>StartupTN records where you are at the moment you check in and check out, to confirm attendance.</p>}
          <ul className="list-disc space-y-1 pl-5 text-muted">
            {today.selfieRequired && <li>Your camera opens only when you press Check in or Check out. The photo is taken once, when you press the button.</li>}
            <li>Your latitude, longitude and GPS accuracy are saved with it{today.selfieRequired ? '' : ', and only when you press Check in or Check out'}.</li>
            <li>Nothing is tracked or recorded in the background.</li>
            {today.selfieRequired && <li>Photos are deleted after {today.selfieRetentionDays} days. The time and place of the check-in stay.</li>}
            <li>Your reporting managers and HR can see these check-ins{today.selfieRequired ? ' and photos' : ''}. Nobody else can.</li>
          </ul>
          <p className="text-muted">If you would rather not share {today.selfieRequired ? 'your photo or location' : 'your location'}, speak to HR before you check in.</p>
        </div>
        <FormActions>
          <Button variant="secondary" onClick={() => setPhase('idle')}>Not now</Button>
          <Button onClick={() => void accept()}>I agree</Button>
        </FormActions>
      </Dialog>
    </div>
  );
}

function EventList({ events }: { events: PunchEvent[] }) {
  return (
    <ol className="mt-6 divide-y divide-line border-t border-line">
      {events.map((e) => {
        const odd = e.flags.filter((f) => f !== 'regularised');
        return (
          <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm">
            <SelfieThumb event={e} label={`${e.type === 'check_in' ? 'checked in' : 'checked out'} at ${fmtClock(e.at)}`} />
            <span className="w-20 font-medium">{fmtClock(e.at)}</span>
            <span className={cx('w-24', e.type === 'check_in' ? 'text-peacock-dark' : 'text-muted')}>{e.type === 'check_in' ? 'Checked in' : 'Checked out'}</span>
            <span className="min-w-0 flex-1 text-muted">
              {SOURCE_LABEL[e.source] ?? (e.geofenceName ? (e.withinGeofence ? `At ${e.geofenceName}` : `Away from ${e.geofenceName}`)
                : e.withinGeofence === false ? 'Outside the office area' : 'Location saved')}
            </span>
            {odd.length > 0 && <span className="flex flex-wrap gap-1">{odd.map((f) => <Badge key={f} tone="marigold">{flagLabel(f)}</Badge>)}</span>}
          </li>
        );
      })}
    </ol>
  );
}
