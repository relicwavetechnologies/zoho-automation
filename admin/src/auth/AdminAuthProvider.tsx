import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { api } from '../lib/api';
import type { AdminNavItem, AdminSession } from './types';

type AdminAuthContextValue = {
  token: string | null;
  session: AdminSession | null;
  navItems: AdminNavItem[];
  loading: boolean;
  loginSuperAdmin: (email: string, password: string) => Promise<void>;
  loginCompanyAdmin: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const TOKEN_KEY = 'control_plane_admin_token';

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

const readStoredToken = (): string | null => {
  return localStorage.getItem(TOKEN_KEY);
};

export const AdminAuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [token, setToken] = useState<string | null>(readStoredToken);
  const [session, setSession] = useState<AdminSession | null>(null);
  const [navItems, setNavItems] = useState<AdminNavItem[]>([]);
  const [loading, setLoading] = useState(true);

  const persistToken = (value: string | null) => {
    if (value) {
      localStorage.setItem(TOKEN_KEY, value);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
    setToken(value);
  };

  const fetchSession = async (activeToken: string) => {
    const [resolvedSession, capabilities] = await Promise.all([
      api.get<AdminSession>('/api/admin/auth/me', activeToken),
      api.get<{ navItems: AdminNavItem[] }>('/api/admin/auth/capabilities', activeToken),
    ]);
    setSession(resolvedSession);
    setNavItems(
      capabilities.navItems.map((item) => ({
        ...item,
        label: item.label === 'Companies' ? 'Workspaces' : item.label,
        path: item.path === '/companies' ? '/workspaces' : item.path,
      })),
    );
  };

  useEffect(() => {
    const bootstrap = async () => {
      if (!token) {
        setSession(null);
        setNavItems([]);
        setLoading(false);
        return;
      }

      try {
        await fetchSession(token);
      } catch {
        persistToken(null);
        setSession(null);
        setNavItems([]);
      } finally {
        setLoading(false);
      }
    };

    void bootstrap();
  }, [token]);

  const loginSuperAdmin = async (email: string, password: string) => {
    const result = await api.post<{ token: string; session: AdminSession }>(
      '/api/admin/auth/login/super-admin',
      { email, password },
    );
    persistToken(result.token);
    await fetchSession(result.token);
  };

  const loginCompanyAdmin = async (email: string, password: string) => {
    const result = await api.post<{ token: string; session: AdminSession }>(
      '/api/admin/auth/login/company-admin',
      { email, password },
    );
    persistToken(result.token);
    await fetchSession(result.token);
  };

  const logout = async () => {
    if (token) {
      try {
        await api.post('/api/admin/auth/logout', {}, token);
      } catch {
        // noop
      }
    }

    persistToken(null);
    setSession(null);
    setNavItems([]);
  };

  const value = useMemo<AdminAuthContextValue>(
    () => ({
      token,
      session,
      navItems,
      loading,
      loginSuperAdmin,
      loginCompanyAdmin,
      logout,
    }),
    [loading, navItems, session, token],
  );

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
};

export const useAdminAuth = () => {
  const context = useContext(AdminAuthContext);
  if (!context) {
    throw new Error('useAdminAuth must be used within AdminAuthProvider');
  }

  return context;
};
