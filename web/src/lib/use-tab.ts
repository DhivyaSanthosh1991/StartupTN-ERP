'use client';

import { useCallback, useEffect, useState } from 'react';

/** Tab state that honours ?tab=… on arrival (links from the home page and emails) and keeps the address in step. */
export function useTab<T extends string>(valid: readonly T[], fallback: T): [T, (t: T) => void] {
  const [tab, setTab] = useState<T>(fallback);
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    if (wanted && (valid as readonly string[]).includes(wanted)) setTab(wanted as T);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const choose = useCallback((t: T) => {
    setTab(t);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', t);
    window.history.replaceState(null, '', url);
  }, []);
  return [tab, choose];
}
