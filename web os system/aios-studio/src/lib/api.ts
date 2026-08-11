'use client';

export interface ApiUser { id: string; email: string; displayName: string; role: string }
type Envelope<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string; detail?: unknown } };

const ACCESS_KEY = 'aios-studio.access';
const REFRESH_KEY = 'aios-studio.refresh';
export const AUTH_EXPIRED_EVENT = 'aios-studio:auth-expired';

export const tokens = {
  get access() { return typeof window === 'undefined' ? null : localStorage.getItem(ACCESS_KEY); },
  get refresh() { return typeof window === 'undefined' ? null : localStorage.getItem(REFRESH_KEY); },
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  },
};

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let refreshInFlight: Promise<boolean> | null = null;
async function refreshAccess(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const refresh = tokens.refresh;
    if (!refresh) return false;
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh, client: 'web' }),
      });
      const body = await response.json() as Envelope<{ access: string; refresh: string }>;
      if (!response.ok || !body.success) {
        if (response.status === 401 || response.status === 403) tokens.clear();
        return false;
      }
      tokens.set(body.data.access, body.data.refresh);
      return true;
    } catch { return false; }
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

function normalize(path: string): string {
  if (path.startsWith('/api/') || path.startsWith('/mcp/')) return path;
  return `/api${path.startsWith('/') ? path : `/${path}`}`;
}

export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  if (tokens.access) headers.set('authorization', `Bearer ${tokens.access}`);
  const response = await fetch(normalize(path), { ...init, headers });
  if (response.status === 401 && retry && await refreshAccess()) return api<T>(path, init, false);
  const body = await response.json().catch(() => ({ success: false, error: { code: 'PARSE', message: '服務回應格式錯誤' } })) as Envelope<T>;
  if (!body.success) throw new ApiError(body.error.code, body.error.message, body.error.detail);
  return body.data;
}

export const API = {
  get: <T,>(path: string) => api<T>(path),
  post: <T,>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T,>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
};
