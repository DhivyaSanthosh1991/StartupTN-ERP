'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

export const UNAUTHORISED_EVENT = 'erp:unauthorised';

/** Calls the API (paths are relative to /api). Throws ApiError with the server's code and message. */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown; text?: boolean } = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  // `text` sends a string as it is (a file's contents) instead of as JSON.
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (hasBody ? 'POST' : 'GET'),
    headers: hasBody ? { 'Content-Type': init.text ? 'text/plain; charset=utf-8' : 'application/json' } : undefined,
    body: hasBody ? (init.text ? String(init.body) : JSON.stringify(init.body)) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: leave data null */
  }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORISED_EVENT));
    throw new ApiError(res.status, data?.code ?? 'ERROR', data?.message ?? `Something went wrong (${res.status})`, data?.issues ?? []);
  }
  return data as T;
}

/** A message fit to show a person, with field problems spelled out. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'VALIDATION' && e.issues.length) return e.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('. ');
    return e.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong';
}

export function useApi<T = any>(path: string | null) {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: path !== null });
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (path === null) return;
    const run = ++latest.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await api<T>(path);
      if (run === latest.current) setState({ data, loading: false });
    } catch (e) {
      if (run === latest.current) setState((s) => ({ data: s.data, error: e as ApiError, loading: false }));
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data: state.data, error: state.error, loading: state.loading, reload: load };
}
