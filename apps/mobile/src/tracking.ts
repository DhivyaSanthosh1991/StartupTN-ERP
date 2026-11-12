import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { api } from './api';
import type { TrackState } from './types';

export const TRACK_TASK = 'erp-track';

/**
 * Background readings between check-in and check-out. The phone's own location service wakes the app
 * every few minutes with one coarse (wifi and mobile tower) reading, which keeps battery use small.
 * The server decides whether the reading counts; if the person has checked out or is on a break it says
 * active:false and the task stops itself.
 */
TaskManager.defineTask(TRACK_TASK, async ({ data, error }) => {
  if (error) return;
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
  const last = locations?.[locations.length - 1];
  if (!last) return;
  try {
    const state = await api<TrackState>('/attendance/track', {
      method: 'POST',
      body: { latitude: last.coords.latitude, longitude: last.coords.longitude, accuracyM: last.coords.accuracy ?? undefined },
    });
    if (state.away && !state.away.explained) {
      await Notifications.scheduleNotificationAsync({
        identifier: `away-${state.away.id}`,
        content: { title: 'You seem to be away from the office', body: 'Open the app and tell us why (official work, break or personal).' },
        trigger: null,
      });
    }
    if (!state.active && !state.away) await stopTracking();
  } catch {
    /* no signal: the next reading will try again */
  }
});

export async function isTracking(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(TRACK_TASK);
  } catch {
    return false;
  }
}

export type TrackingStart = 'started' | 'foreground_only' | 'denied';

/** Asks for the permissions and starts the readings. Falls back to "while the app is open" when "all the time" is refused. */
export async function startTracking(intervalMinutes: number): Promise<TrackingStart> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return 'denied';
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') return 'foreground_only';
  if (await isTracking()) return 'started';
  await Location.startLocationUpdatesAsync(TRACK_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: Math.max(1, intervalMinutes) * 60_000,
    distanceInterval: 0,
    deferredUpdatesInterval: Math.max(1, intervalMinutes) * 60_000,
    pausesUpdatesAutomatically: true,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'StartupTN: location sharing is on',
      notificationBody: 'Only between check-in and check-out. It stops when you check out.',
    },
  });
  return 'started';
}

export async function stopTracking() {
  try {
    if (await isTracking()) await Location.stopLocationUpdatesAsync(TRACK_TASK);
  } catch {
    /* already stopped */
  }
}
