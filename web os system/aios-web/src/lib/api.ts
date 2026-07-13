'use client';
// Typed API client for the AIOS backend. Same-origin (Next rewrites /api/* to
// the local backend). Holds the access/refresh tokens and auto-refreshes on 401.

export interface ApiUser { id: string; email: string; displayName: string; role: string }
type Envelope<T> = { success: true; data: T } | { success: false; error: { code: string; message: string; detail?: unknown } };

const ACCESS_KEY = 'aios.access';
const REFRESH_KEY = 'aios.refresh';

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
  },
};

class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

async function refreshAccess(): Promise<boolean> {
  const refresh = tokens.refresh;
  if (!refresh) return false;
  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh, client: 'web' }),
  });
  const body = (await res.json()) as Envelope<{ access: string; refresh: string }>;
  if (!body.success) { tokens.clear(); return false; }
  tokens.set(body.data.access, body.data.refresh);
  return true;
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
  if (tokens.access) headers.set('authorization', `Bearer ${tokens.access}`);

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && retry && (await refreshAccess())) {
    return api<T>(path, init, false);
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
