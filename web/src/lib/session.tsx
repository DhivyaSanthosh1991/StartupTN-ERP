'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { UNAUTHORISED_EVENT, api } from './api';

export type Role = 'hod' | 'md' | 'hr_admin' | 'finance' | 'super_admin';

export interface Me {
  id: string;
  empCode: string;
  fullName: string;
  officialEmail: string;
  designation: string | null;
  departmentId: string | null;
  departmentName: string | null;
  reportingManagerName: string | null;
  roles: Role[];
  isManager: boolean;
  directReports: number;
  locationConsentAt: string | null;
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  has: (...roles: Role[]) => boolean;
  /** Looks after other people's attendance and leave: a manager, a head of department, or HR. */
  oversees: boolean;
  isHr: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/me'));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onOut = () => setMe(null);
    window.addEventListener(UNAUTHORISED_EVENT, onOut);
    return () => window.removeEventListener(UNAUTHORISED_EVENT, onOut);
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      setMe(null);
    }
  }, []);

  const value = useMemo<SessionValue>(() => {
    const has = (...roles: Role[]) => !!me && roles.some((r) => me.roles.includes(r));
    return { me, loading, refresh, logout, has, isHr: has('hr_admin'), oversees: !!me && (me.isManager || has('hod', 'hr_admin')) };
  }, [me, loading, refresh, logout]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}

/** Same as useSession, for screens that only render once a person is signed in. */
export function useMe(): Me {
  const { me } = useSession();
  if (!me) throw new Error('Not signed in');
  return me;
}
