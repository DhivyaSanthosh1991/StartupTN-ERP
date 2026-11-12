import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { api, errorText } from './api';
import { useSession } from './auth';
import { SelfieSheet } from './Selfie';
import { startTracking, stopTracking } from './tracking';
import type { TodayAttendance, TrackState } from './types';
import { Button, Notice, Sheet, colors, s } from './ui';

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
const hm = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

async function readLocation() {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new Error('Location is blocked. Allow location for this app in your phone settings, then try again.');
  // Indoors a precise GPS fix can take minutes, so ask for a balanced reading (wifi and towers) and give up after 20 seconds.
  const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error('Your phone could not find your location. Turn on location (GPS), move near a window or outside, then try again.')), 20_000));
  const p = await Promise.race([Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }), timeout]);
  return { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: p.coords.accuracy ?? undefined };
}

const AWAY_KINDS = [
  { value: 'official', label: 'Official work' },
  { value: 'break', label: 'Break (lunch, tea)' },
  { value: 'personal', label: 'Personal reason' },
  { value: 'other', label: 'Other' },
] as const;

export function Home() {
  const { user, logout } = useSession();
  const [today, setToday] = useState<TodayAttendance | null>(null);
  const [track, setTrack] = useState<TrackState | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'consent' | 'selfie'>('idle');
  const [pending, setPending] = useState<'check-in' | 'check-out'>('check-in');
  const [trackNote, setTrackNote] = useState('');
  const [check, setCheck] = useState<{ id: string; expiresAt: string } | null>(null);
  const [checkResult, setCheckResult] = useState('');
  const [awayKind, setAwayKind] = useState<(typeof AWAY_KINDS)[number]['value']>('official');
  const [awayNote, setAwayNote] = useState('');
  const [awaySnooze, setAwaySnooze] = useState(0);
  const checkId = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, k] = await Promise.all([api<TodayAttendance>('/attendance/today'), api<TrackState>('/attendance/track')]);
      setToday(t);
      setTrack(k);
      setError('');
      return { t, k };
    } catch (e) {
      setError(errorText(e));
      return null;
    }
  }, []);

  // keep readings going exactly while the person is checked in and not on a break
  const syncTracking = useCallback(async (k: TrackState | null) => {
    if (!k) return;
    if (k.active) {
      const r = await startTracking(k.intervalMinutes);
      setTrackNote(r === 'started' ? '' : r === 'foreground_only'
        ? 'Location is set to "while using the app". For the office-boundary alert to work with the screen off, choose "Allow all the time" for this app in phone settings.'
        : 'Location is blocked, so HR cannot see if you leave the office. Allow location for this app in phone settings.');
    } else if (!k.away) {
      await stopTracking();
      setTrackNote('');
    }
  }, []);

  useEffect(() => { void load().then((r) => syncTracking(r?.k ?? null)); }, [load, syncTracking]);

  // once a minute while the app is open: the random presence question, and anyone left unexplained
  useEffect(() => {
    const poll = async () => {
      if (AppState.currentState !== 'active') return;
      try {
        const r = await api<{ check: { id: string; expiresAt: string } | null }>('/attendance/presence');
        if (r.check?.id !== checkId.current) { checkId.current = r.check?.id ?? null; setCheck(r.check); setCheckResult(''); }
        const k = await api<TrackState>('/attendance/track');
        setTrack(k);
      } catch { /* next minute */ }
    };
    void poll();
    const t = setInterval(poll, 60_000);
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') void load().then((r) => syncTracking(r?.k ?? null)).then(poll); });
    const n = Notifications.addNotificationReceivedListener(() => void poll());
    return () => { clearInterval(t); sub.remove(); n.remove(); };
  }, [load, syncTracking]);

  async function refresh() {
    setRefreshing(true);
    const r = await load();
    await syncTracking(r?.k ?? null);
    setRefreshing(false);
  }

  function begin(kind: 'check-in' | 'check-out') {
    if (!today) return;
    setPending(kind);
    setError('');
    if (!today.locationConsent || (today.selfieRequired && !today.photoConsent)) return setPhase('consent');
    void afterConsent(kind);
  }

  async function afterConsent(kind: 'check-in' | 'check-out') {
    if (today?.selfieRequired) return setPhase('selfie');
    setPhase('idle');
    await submit(kind);
  }

  async function agree() {
    setBusy(true);
    try {
      if (!today?.locationConsent) await api('/me/location-consent', { method: 'POST', body: {} });
      if (today?.selfieRequired && !today.photoConsent) await api('/me/photo-consent', { method: 'POST', body: {} });
      const r = await load();
      if (r) { setToday(r.t); }
      setPhase('idle');
      if (r?.t.selfieRequired) setPhase('selfie'); else await submit(pending);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit(kind: 'check-in' | 'check-out', selfie?: string) {
    setBusy(true);
    setPhase('idle');
    try {
      const loc = await readLocation();
      const next = await api<TodayAttendance>(`/attendance/${kind}`, { method: 'POST', body: { ...loc, source: 'mobile', ...(selfie ? { selfie } : {}) } });
      setToday(next);
      setBusy(false); // the punch is saved; the tracking follow-up must never keep the button spinning
      void api<TrackState>('/attendance/track').then((k) => { setTrack(k); return syncTracking(k); }).catch(() => {});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function doBreak(action: 'start' | 'end') {
    setBusy(true);
    try {
      await api(`/attendance/break/${action}`, { method: 'POST', body: action === 'start' ? { kind: 'lunch' } : {} });
      const r = await load();
      await syncTracking(r?.k ?? null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function answerCheck() {
    if (!check) return;
    setBusy(true);
    try {
      const loc = await readLocation();
      const r = await api<{ status: 'ok' | 'outside' }>(`/attendance/presence/${check.id}`, { method: 'POST', body: loc });
      setCheckResult(r.status === 'ok' ? 'Thanks, you are confirmed.' : 'Your location was recorded.');
      setTimeout(() => { setCheck(null); setCheckResult(''); }, 1500);
    } catch (e) {
      setCheckResult(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function explain() {
    if (!track?.away) return;
    setBusy(true);
    try {
      const k = await api<TrackState>(`/attendance/track/alerts/${track.away.id}`, { method: 'POST', body: { kind: awayKind, note: awayNote.trim() || undefined } });
      setTrack(k);
      setAwayNote('');
      const r = await load();
      await syncTracking(r?.k ?? k);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!today) {
    return (
      <View style={[s.screen, s.pad, { justifyContent: 'center' }]}>
        {error ? <Notice tone="error" text={error} /> : <Text style={s.body}>Loading today…</Text>}
        {error ? <Button title="Try again" onPress={() => void load()} /> : null}
      </View>
    );
  }

  const checkedIn = today.canCheckOut;
  const onBreak = today.breaks?.onBreak;
  const status = today.info.holiday ? `Holiday: ${today.info.holiday}` : today.info.leave ? `On leave: ${today.info.leave}` : today.info.weeklyOff ? 'Weekly off' : null;
  const asking = !!track?.away && !track.away.explained && Date.now() > awaySnooze;

  return (
    <View style={s.screen}>
      <ScrollView contentContainerStyle={s.pad} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
        <Text style={s.muted}>Hello</Text>
        <Text style={s.h1}>{user?.fullName}</Text>
        <Text style={[s.muted, { marginBottom: 14 }]}>{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' })}</Text>

        {status ? <Notice text={status} /> : null}
        {error ? <Notice tone="error" text={error} /> : null}
        {trackNote ? <Notice text={trackNote} /> : null}
        {today.attendanceMethod === 'biometric' && !today.canPunch ? <Notice text="Your attendance is taken on the biometric machine." /> : null}

        <View style={{ backgroundColor: colors.white, borderRadius: 16, padding: 18, marginVertical: 10, borderWidth: 1, borderColor: colors.line }}>
          <Text style={s.muted}>Worked today</Text>
          <Text style={[s.h1, { fontSize: 34 }]}>{hm(today.day?.workedMinutes ?? 0)}</Text>
          <Text style={s.muted}>{checkedIn ? (onBreak ? 'On break (counts as work time)' : `Checked in since ${today.openSince ? clock(today.openSince) : ''}`) : today.state === 'checked_out' ? 'Checked out' : 'Not checked in'}</Text>
          {today.canPunch && (today.canCheckIn || today.canCheckOut) ? (
            <Button title={checkedIn ? 'Check out' : 'Check in'} onPress={() => begin(checkedIn ? 'check-out' : 'check-in')} busy={busy} kind={checkedIn ? 'danger' : 'primary'} />
          ) : null}
        </View>

        {checkedIn ? (
          onBreak ? <Button title="I am back at work" onPress={() => void doBreak('end')} busy={busy} />
                  : <Button title="Out for lunch or a break" kind="quiet" onPress={() => void doBreak('start')} busy={busy} />
        ) : null}

        {today.events.length ? (
          <View style={{ marginTop: 14 }}>
            <Text style={[s.body, { fontWeight: '700' }]}>Today</Text>
            {today.events.map((e) => (
              <Text key={e.id} style={s.body}>{e.type === 'check_in' ? 'In' : 'Out'} {clock(e.at)}{e.geofenceName ? `, ${e.geofenceName}` : e.withinGeofence === false ? ', outside the office' : ''}</Text>
            ))}
          </View>
        ) : null}

        <View style={{ marginTop: 30 }}><Button title="Sign out" kind="quiet" onPress={() => void logout()} /></View>
      </ScrollView>

      <Sheet open={phase === 'consent'} title="Before you check in">
        <Text style={s.body}>
          The app reads your location when you check in or out, and roughly every few minutes between check-in and check-out so HR can see if you leave the office without a reason. It stops when you check out or are on a break. {today.selfieRequired ? 'A selfie is also taken at each check-in and check-out and kept for a limited time.' : ''}
        </Text>
        <Button title="I agree" onPress={agree} busy={busy} />
        <Button title="Not now" kind="quiet" onPress={() => setPhase('idle')} />
      </Sheet>

      <SelfieSheet open={phase === 'selfie'} onCancel={() => setPhase('idle')} onDone={(b64) => void submit(pending, b64)} />

      <Sheet open={!!check} title="Are you at your work location?">
        <Text style={s.body}>Please confirm where you are. This takes a moment.</Text>
        {checkResult ? <Notice text={checkResult} tone={checkResult.startsWith('Thanks') ? 'ok' : 'info'} /> : null}
        <Button title="Yes, confirm my location" onPress={answerCheck} busy={busy} />
      </Sheet>

      <Sheet open={asking} title="You seem to be away from the office">
        <Text style={s.body}>Tell us why so HR knows.</Text>
        {AWAY_KINDS.map((k) => (
          <Button key={k.value} title={`${awayKind === k.value ? '● ' : '○ '}${k.label}`} kind="quiet" onPress={() => setAwayKind(k.value)} />
        ))}
        <TextInput style={[s.input, { marginVertical: 8 }]} value={awayNote} onChangeText={setAwayNote} placeholder="Where are you? (needed for official or other)" />
        <Button title="Send" onPress={explain} busy={busy} disabled={(awayKind === 'official' || awayKind === 'other') && !awayNote.trim()} />
        <Button title="Later" kind="quiet" onPress={() => setAwaySnooze(Date.now() + 10 * 60_000)} />
      </Sheet>
    </View>
  );
}
