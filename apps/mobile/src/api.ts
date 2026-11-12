import * as SecureStore from 'expo-secure-store';
import { API_URL } from './config';

const TOKEN_KEY = 'erp_token';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const getToken = () => SecureStore.getItemAsync(TOKEN_KEY);
export const setToken = (t: string) => SecureStore.setItemAsync(TOKEN_KEY, t);
export const clearToken = () => SecureStore.deleteItemAsync(TOKEN_KEY);

let onUnauthorised: (() => void) | null = null;
export const setUnauthorisedHandler = (fn: (() => void) | null) => { onUnauthorised = fn; };

/** Calls the API. The free server may be asleep, so the first call waits up to a minute. */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await getToken();
  const hasBody = init.body !== undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method: init.method ?? (hasBody ? 'POST' : 'GET'),
      headers: {
        'x-client': 'mobile',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: hasBody ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your internet connection and try again.');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* the server was waking up and sent a page */ }
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorised?.();
    const message = data?.message ?? (res.status >= 500 ? 'The server is waking up. Wait a few seconds and try again.' : `Something went wrong (${res.status})`);
    throw new ApiError(res.status, data?.code ?? 'ERROR', message);
  }
  return data as T;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
