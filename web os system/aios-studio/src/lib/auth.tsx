'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { API, AUTH_EXPIRED_EVENT, tokens, type ApiUser } from './api';

type AuthState = {
  user: ApiUser | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): void;
};
const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const expired = () => setUser(null);
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    (async () => {
      if (tokens.access || tokens.refresh) {
        try { setUser(await API.get<ApiUser>('/api/auth/me')); } catch { tokens.clear(); }
      }
      setLoading(false);
    })();
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
  }, []);
  async function login(email: string, password: string) {
    const result = await API.post<{ access: string; refresh: string; user: ApiUser }>('/api/auth/login', { email, password, client: 'web' });
    tokens.set(result.access, result.refresh);
    setUser(result.user);
  }
  function logout() {
    const refresh = tokens.refresh;
    if (refresh) API.post('/api/auth/logout', { refresh }).catch(() => undefined);
    tokens.clear();
    setUser(null);
  }
  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}

export function isFde(role?: string | null) { return role === 'OWNER' || role === 'TRAINER'; }
