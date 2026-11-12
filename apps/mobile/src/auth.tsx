import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { api, clearToken, getToken, setToken, setUnauthorisedHandler } from './api';
import { stopTracking } from './tracking';
import type { Profile } from './types';

interface Session {
  user: Profile | null;
  ready: boolean;
  login: (email: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<Session>(null as unknown as Session);
export const useSession = () => useContext(Ctx);

async function registerPush() {
  try {
    if (!Device.isDevice) return;
    const perm = await Notifications.requestPermissionsAsync();
    if (perm.status !== 'granted') return;
    const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId ?? (Constants as any).easConfig?.projectId;
    const t = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    await api('/devices', { method: 'POST', body: { pushToken: t.data, platform: Platform.OS === 'ios' ? 'ios' : 'android', appVersion: Constants.expoConfig?.version } });
  } catch {
    /* notifications are a convenience, never a reason to block sign-in */
  }
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<Profile | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    if (!(await getToken())) return setUser(null);
    try {
      const me = await api<any>('/me');
      setUser({ id: me.id, fullName: me.fullName ?? me.full_name, empCode: me.empCode });
      void registerPush();
    } catch (e: any) {
      if (e?.status === 401) { await clearToken(); setUser(null); }
    }
  }, []);

  useEffect(() => {
    setUnauthorisedHandler(() => { void clearToken(); setUser(null); });
    void load().finally(() => setReady(true));
    return () => setUnauthorisedHandler(null);
  }, [load]);

  const login = useCallback(async (email: string) => {
    const r = await api<{ token: string }>('/auth/dev-login', { method: 'POST', body: { email: email.trim().toLowerCase() } });
    await setToken(r.token);
    await load();
  }, [load]);

  const logout = useCallback(async () => {
    await stopTracking();
    await clearToken();
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, ready, login, logout }}>{children}</Ctx.Provider>;
}
