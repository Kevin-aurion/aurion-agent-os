'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { API, tokens, type ApiUser } from './api';

interface AuthState {
  user: ApiUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, displayName: string, password: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      if (tokens.access) {
        try { setUser(await API.get<ApiUser>('/api/auth/me')); } catch { tokens.clear(); }
      }
      setLoading(false);
    })();
  }, []);

  async function login(email: string, password: string) {
    const r = await API.post<{ access: string; refresh: string; user: ApiUser }>('/api/auth/login', { email, password, client: 'web' });
    tokens.set(r.access, r.refresh);
    setUser(r.user);
  }
  async function register(email: string, displayName: string, password: string) {
    const r = await API.post<{ access: string; refresh: string; user: ApiUser }>('/api/auth/register', { email, displayName, password });
    tokens.set(r.access, r.refresh);
    setUser(r.user);
  }
  function logout() {
    const refresh = tokens.refresh;
    if (refresh) API.post('/api/auth/logout', { refresh }).catch(() => {});
    tokens.clear();
    setUser(null);
  }

  return <Ctx.Provider value={{ user, loading, login, register, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used within AuthProvider');
  return c;
}

/** FDE = OWNER or TRAINER; can train agents and review change proposals. */
export function isFdeRole(role: string | undefined | null): boolean {
  return role === 'OWNER' || role === 'TRAINER';
}
