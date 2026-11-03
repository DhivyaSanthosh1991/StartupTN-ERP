'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorText } from '@/lib/api';
import type { PunchEvent } from '@/lib/types';
import { Button, Dialog, Notice, cx } from './ui';

// ------------------------------------------------------------------ thumbnail

/**
 * A small photo taken at a punch, opening larger on tap. The picture is fetched from the API with the
 * viewer's own session, so it only loads for the person, their managers and HR.
 */
export function SelfieThumb({ event, label }: { event: Pick<PunchEvent, 'id' | 'selfie' | 'selfiePurged'>; label: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  if (event.selfiePurged) return <span className="text-xs text-muted">Photo deleted</span>;
  if (!event.selfie) return null;
  if (failed) return <span className="text-xs text-muted">Photo unavailable</span>;
  const src = `/api/attendance/events/${event.id}/selfie`;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={`View selfie, ${label}`}
        className="shrink-0 overflow-hidden rounded-lg border border-line hover:border-peacock focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-peacock">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" className="size-10 object-cover" onError={() => setFailed(true)} />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Selfie">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={`Selfie, ${label}`} className="w-full rounded-lg bg-wash" />
        <p className="mt-2 text-sm text-muted">{label}</p>
      </Dialog>
    </>
  );
}

// -------------------------------------------------------------------- capture

export interface Capture {
  /** The photo as a `data:image/jpeg;base64,…` URL. */
  selfie: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
}

interface Fix { latitude: number; longitude: number; accuracyM: number; at: number }

/** A GPS fix worse than this is refused by the server, so the button waits for a better one. */
const REFUSED_ACCURACY_M = 500;
const FIX_MAX_AGE_MS = 30_000;
const PHOTO_MAX_EDGE = 640;
const PHOTO_MAX_BYTES = 250_000;

function cameraProblem(e: unknown): string {
  const name = (e as DOMException | undefined)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The camera is blocked for this site. Allow the camera in your browser settings (the icon next to the address), then press Try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The camera is being used by another app. Close it, then press Try again.';
  return 'The camera could not be started. Check that it is connected and allowed for this site, then press Try again.';
}

function locationProblem(e: unknown): string {
  const code = (e as GeolocationPositionError | undefined)?.code;
  if (code === 1) return 'Location is blocked for this site. Allow location in your browser settings, then press Try again.';
  if (code === 2) return 'Your device could not work out where you are. Move to an open area or turn on location services.';
  if (code === 3) return 'Finding your location is taking too long. Move to an open area.';
  return 'Your location could not be read.';
}

function currentFix(): Promise<Fix> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: p.coords.accuracy, at: Date.now() }),
      reject, { enableHighAccuracy: true, maximumAge: FIX_MAX_AGE_MS, timeout: 10_000 });
  });
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Draws the current video frame, shrunk, as a JPEG small enough to send and keep. */
async function grabFrame(video: HTMLVideoElement): Promise<{ dataUrl: string; blob: Blob }> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) throw new Error('The camera is not ready yet.');
  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.74, 0.6, 0.45]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (blob && blob.size <= PHOTO_MAX_BYTES) return { blob, dataUrl: await readAsDataUrl(blob) };
  }
  throw new Error('The photo came out too large. Try again in better light.');
}

type CameraState = { state: 'starting' } | { state: 'ready' } | { state: 'failed'; message: string };

/**
 * The check-in screen: the front camera opens, the device's location is followed automatically, and
 * one press takes the selfie and reads the location at that same moment. Nothing runs before this
 * screen opens or after it closes; the camera and the location watch are both stopped on the way out.
 */
export function SelfieCapture({ kind, onCancel, onSubmit }: {
  kind: 'check-in' | 'check-out';
  onCancel: () => void;
  onSubmit: (capture: Capture) => Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fixRef = useRef<Fix | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [camera, setCamera] = useState<CameraState>({ state: 'starting' });
  const [fix, setFix] = useState<Fix | null>(null);
  const [geoError, setGeoError] = useState('');
  const [shot, setShot] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // The camera.
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    setCamera({ state: 'starting' });
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamera({ state: 'failed', message: 'This browser cannot open the camera here. Camera access needs a secure (https) address.' });
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 960 } }, audio: false });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        setCamera({ state: 'ready' });
      } catch (e) {
        if (!cancelled) setCamera({ state: 'failed', message: cameraProblem(e) });
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [attempt]);

  // The location, followed while the screen is open so the best fix is ready when the button is pressed.
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGeoError('This browser cannot share a location.');
      return;
    }
    setGeoError('');
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const next = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: p.coords.accuracy, at: Date.now() };
        fixRef.current = next;
        setFix(next);
        setGeoError('');
      },
      (e) => { if (!fixRef.current || e.code === 1) setGeoError(locationProblem(e)); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [attempt]);

  const take = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    setError('');
    setSaving(true);
    try {
      // The frame is taken first, in the same instant as the press; the position is then the freshest one held.
      const { dataUrl } = await grabFrame(video);
      setShot(dataUrl);
      let at = fixRef.current;
      if (!at || Date.now() - at.at > FIX_MAX_AGE_MS) at = await currentFix().catch(() => fixRef.current);
      if (!at) throw new Error('Your location is not available yet.');
      if (at.accuracyM > REFUSED_ACCURACY_M) {
        throw new Error(`Your location is only accurate to ${Math.round(at.accuracyM)} m. Move to an open area or turn on precise location, then try again.`);
      }
      await onSubmit({ selfie: dataUrl, latitude: at.latitude, longitude: at.longitude, accuracyM: at.accuracyM });
    } catch (e) {
      setShot(null);
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : errorText(e));
      setSaving(false);
    }
  }, [onSubmit]);

  const verb = kind === 'check-in' ? 'check in' : 'check out';
  const cameraReady = camera.state === 'ready';
  const weak = fix !== null && fix.accuracyM > REFUSED_ACCURACY_M;
  const canTake = cameraReady && fix !== null && !weak && !saving;
  const failedHere = camera.state === 'failed' || (!!geoError && !fix);

  return (
    <Dialog open onClose={onCancel} title={kind === 'check-in' ? 'Check in' : 'Check out'}>
      <div className="space-y-4">
        <div className="relative mx-auto aspect-[4/3] w-full overflow-hidden rounded-xl bg-ink">
          {/* The preview is mirrored like a mirror; the saved photo is not. */}
          <video ref={videoRef} playsInline muted autoPlay aria-label="Camera preview"
            className={cx('size-full -scale-x-100 object-cover', !cameraReady && 'invisible')} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {shot && <img src={shot} alt="The photo just taken" className="absolute inset-0 size-full -scale-x-100 object-cover" />}
          {cameraReady && !shot && (
            <svg viewBox="0 0 100 75" className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
              <ellipse cx="50" cy="36" rx="19" ry="25" fill="none" stroke="white" strokeOpacity="0.55" strokeWidth="0.7" strokeDasharray="2.5 2" />
            </svg>
          )}
          {camera.state === 'starting' && <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-white/80">Starting the camera</p>}
          {camera.state === 'failed' && <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-white/80">The camera is off</p>}
          {saving && shot && (
            <div className="absolute inset-x-0 bottom-0 bg-ink/70 px-3 py-2 text-center text-sm font-medium text-white">Saving your {verb}</div>
          )}
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-muted">Camera</dt>
          <dd className={cx('font-medium', cameraReady && 'text-peacock-dark')}>
            {camera.state === 'starting' ? 'Starting' : cameraReady ? 'Ready' : 'Not available'}
          </dd>
          <dt className="text-muted">Location</dt>
          <dd className={cx('font-medium', fix && !weak && 'text-peacock-dark', weak && 'text-kumkum')}>
            {fix ? (weak ? `Too weak, within ${Math.round(fix.accuracyM)} m` : `Found, within ${Math.max(1, Math.round(fix.accuracyM))} m`)
              : geoError ? 'Not available' : 'Finding your location'}
          </dd>
        </dl>

        <div className="space-y-2" aria-live="polite">
          {camera.state === 'failed' && <Notice tone="kumkum">{camera.message}</Notice>}
          {geoError && !fix && <Notice tone="kumkum">{geoError}</Notice>}
          {weak && <Notice tone="marigold">Your location is not precise enough. Move to an open area or near a window.</Notice>}
          {error && <Notice tone="kumkum">{error}</Notice>}
        </div>

        <p className="text-xs text-muted">
          The photo and your location are saved together when you press the button. Nothing is recorded before or after.
        </p>
      </div>

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
        {failedHere
          ? <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
          : <Button busy={saving} disabled={!canTake} onClick={() => void take()}>
              {saving ? 'Saving' : `Take selfie and ${verb}`}
            </Button>}
      </div>
    </Dialog>
  );
}
