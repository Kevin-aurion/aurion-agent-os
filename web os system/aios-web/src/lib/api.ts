'use client';
// Typed API client for the AIOS backend. Same-origin (Next rewrites /api/* to
// the local backend). Holds the access/refresh tokens and auto-refreshes on 401.

export interface ApiUser { id: string; email: string; displayName: string; role: string }
type Envelope<T> = { success: true; data: T } | { success: false; error: { code: string; message: string; detail?: unknown } };

const ACCESS_KEY = 'aios.access';
const REFRESH_KEY = 'aios.refresh';
export const AUTH_EXPIRED_EVENT = 'aios:auth-expired';

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

class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

let refreshInFlight: Promise<boolean> | null = null;

function jwtExpiresWithin(token: string | null, withinMs: number): boolean {
  if (!token) return true;
  try {
    const encoded = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const payload = JSON.parse(
      atob(padded),
    ) as { exp?: number };
    return typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now() + withinMs;
  } catch {
    return true;
  }
}

async function performRefresh(accessBeforeWaiting: string | null): Promise<boolean> {
  const refresh = tokens.refresh;
  if (!refresh) {
    tokens.clear();
    return false;
  }

  // Another tab may have completed the rotation while this tab waited for the
  // shared lock. Reuse its fresh access token instead of rotating again.
  if (
    tokens.access &&
    tokens.access !== accessBeforeWaiting &&
    !jwtExpiresWithin(tokens.access, 10_000)
  ) {
    return true;
  }

  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh, client: 'web' }),
    });
    const body = (await res.json().catch(() => null)) as
      | Envelope<{ access: string; refresh: string }>
      | null;
    if (!res.ok || !body) {
      if (res.status === 401 || res.status === 403) tokens.clear();
      return false;
    }
    if (!body.success) {
      if (res.status === 401 || res.status === 403) tokens.clear();
      return false;
    }
    tokens.set(body.data.access, body.data.refresh);
    return true;
  } catch {
    // A temporary network outage is not proof that the session is invalid.
    // Preserve the refresh token so the next request can retry.
    return false;
  }
}

/** One refresh per tab and, when supported, one refresh across all tabs. */
export function refreshAccess(accessBeforeWaiting = tokens.access): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const run = async () => {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request('aios-auth-refresh', () =>
        performRefresh(accessBeforeWaiting),
      );
    }
    return performRefresh(accessBeforeWaiting);
  };
  refreshInFlight = run().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** Ensure long-lived connections do not start with an almost-expired JWT. */
export async function ensureFreshAccess(withinMs = 60_000): Promise<boolean> {
  if (!jwtExpiresWithin(tokens.access, withinMs)) return true;
  return refreshAccess();
}

/** Normalize an endpoint to the same-origin `/api/*` prefix the Next rewrite
 * proxies to the backend. Pages may pass either `/api/foo` or `/foo`. */
function normalize(path: string): string {
  if (path.startsWith('/api/') || path === '/api' || path.startsWith('/api?')) return path;
  return '/api' + (path.startsWith('/') ? path : '/' + path);
}

export async function api<T = unknown>(rawPath: string, init: RequestInit = {}, retry = true): Promise<T> {
  const path = normalize(rawPath);
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body && !(init.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }
  const accessForRequest = tokens.access;
  if (accessForRequest) headers.set('authorization', `Bearer ${accessForRequest}`);

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && retry) {
    if (await refreshAccess(accessForRequest)) return api<T>(path, init, false);
    if (!tokens.refresh) tokens.clear();
  }
  const body = (await res.json().catch(() => ({ success: false, error: { code: 'PARSE', message: 'bad response' } }))) as Envelope<T>;
  if (!body.success) throw new ApiError(body.error.code, body.error.message);
  return body.data;
}

// Convenience verbs.
export const API = {
  get: <T>(p: string) => api<T>(p),
  post: <T>(p: string, body?: unknown) => api<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(p: string, body?: unknown) => api<T>(p, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(p: string, body?: unknown) => api<T>(p, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(p: string) => api<T>(p, { method: 'DELETE' }),
  upload: <T>(p: string, form: FormData) => api<T>(p, { method: 'POST', body: form }),
};

export { ApiError };
