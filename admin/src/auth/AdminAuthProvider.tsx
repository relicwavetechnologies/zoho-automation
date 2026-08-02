/**
 * The one session the whole app runs on.
 *
 * Sign-in used to be two unrelated systems: this console could only mint an
 * AdminSession, which no /api/desktop route accepts, so the You and Team halves
 * of the Workspace had nothing to fetch. There is now a single member session,
 * and the admin routes accept it when the person's live membership says so.
 *
 * The hook is still called `useAdminAuth` because two dozen files import it and
 * most of those files are being replaced anyway; renaming them now would be
 * churn against code that is about to be deleted.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/query-client';
import type { CompanyRole, Scope, Session, SessionDepartment } from './types';

type MeResponse = {
  userId: string;
  companyId: string;
  companyName: string | null;
  email?: string | null;
  name?: string | null;
  role: CompanyRole;
  departments: SessionDepartment[];
  lark: { connected: boolean } | null;
};

type AdminAuthContextValue = {
  token: string | null;
  session: Session | null;
  scopes: Scope[];
  loading: boolean;
  /**
   * The session could not be read, and it is not because you are signed out.
   * Kept apart so the app can say "cannot reach Divo" instead of showing the
   * login page to somebody who never lost their credential.
   */
  unreachable: boolean;
  /** True while a sign-in attempt is in flight, for the button's own state. */
  signingIn: boolean;
  loginWithPassword: (email: string, password: string) => Promise<void>;
  loginWithLark: () => Promise<void>;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

/**
 * Deliberately not the old `control_plane_admin_token` key. That held a token
 * signed with a different secret which no route in the new world accepts, and
 * reusing the key would have meant every existing tab booting with a token that
 * fails on first request. The old key is cleared on start instead.
 */
const TOKEN_KEY = 'divo_session_token';
const LEGACY_TOKEN_KEY = 'control_plane_admin_token';

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

const readStoredToken = (): string | null => {
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  return localStorage.getItem(TOKEN_KEY);
};

/** The scopes this person can actually reach, from real membership. */
export const scopesFor = (session: Session): Scope[] => {
  const scopes: Scope[] = [
    { kind: 'you', label: 'You', detail: session.email ?? 'Your workspace' },
  ];

  // Managing a department is its own axis. A company admin who leads no
  // department has no team to manage, and showing them an empty Team scope
  // would be inventing a relationship the backend does not have.
  const led = session.departments.filter((d) => d.isManager);
  for (const department of led) {
    scopes.push({
      kind: 'team',
      label: department.name,
      detail: 'You lead this team',
      departmentId: department.id,
    });
  }

  if (session.role === 'COMPANY_ADMIN' || session.role === 'SUPER_ADMIN') {
    scopes.push({
      kind: 'company',
      label: session.companyName ?? 'Company',
      detail: 'Whole company',
    });
  }

  return scopes;
};

/**
 * Runs the Lark OAuth handshake in a popup.
 *
 * The backend mints a signed, single-use state and parks the callback result
 * under its nonce; we poll for it and exchange. Same flow the desktop app uses,
 * which is why it needs no new redirect URI registered with Lark.
 */
async function runLarkPopupFlow(): Promise<string> {
  const start = await api.get<{ authorizeUrl: string; nonce: string }>(
    '/api/desktop/auth/lark/authorize-url',
    undefined,
    { quiet: true },
  );

  const popup = window.open(start.authorizeUrl, 'divo-lark-signin', 'width=520,height=720');
  if (!popup) {
    throw new Error('Your browser blocked the sign-in window. Allow pop-ups for this site and try again.');
  }

  // Ten minutes, matching the TTL the backend signs into the state. Polling
  // past that point would only ever collect an expired handshake.
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    if (popup.closed) {
      // One last look: the popup closes itself on success, so a closed window
      // is ambiguous until the parked result has been checked for.
      const late = await pollOnce(start.nonce);
      if (late) return exchange(late);
      throw new Error('Sign-in was cancelled.');
    }
    const pending = await pollOnce(start.nonce);
    if (pending) {
      popup.close();
      return exchange(pending);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  popup.close();
  throw new Error('Sign-in timed out. Please try again.');
}

type LarkHandshake = { code: string; state: string };

async function pollOnce(nonce: string): Promise<LarkHandshake | null> {
  try {
    return await api.get<LarkHandshake>(
      `/api/desktop/auth/lark/poll?nonce=${encodeURIComponent(nonce)}`,
      undefined,
      { quiet: true },
    );
  } catch {
    // The poll route answers `{ success: false, pending: true }` while it waits,
    // which the shared client reads as a failure. Nothing has gone wrong yet.
    return null;
  }
}

async function exchange(handshake: LarkHandshake): Promise<string> {
  const result = await api.post<{ token: string }>(
    '/api/desktop/auth/lark/exchange',
    handshake,
    undefined,
    { quiet: true },
  );
  return result.token;
}

export const AdminAuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [token, setToken] = useState<string | null>(readStoredToken);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [unreachable, setUnreachable] = useState(false);

  const persistToken = useCallback((value: string | null) => {
    queryClient.clear();
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
    setToken(value);
  }, []);

  const fetchSession = useCallback(async (activeToken: string) => {
    const me = await api.get<MeResponse>('/api/desktop/auth/me', activeToken, { quiet: true });
    setSession({
      userId: me.userId,
      companyId: me.companyId,
      companyName: me.companyName,
      email: me.email ?? null,
      name: me.name ?? null,
      role: me.role,
      departments: me.departments ?? [],
      larkLinked: me.lark?.connected ?? false,
    });
  }, []);

  useEffect(() => {
    let live = true;

    /**
     * Only the server gets to say a session is over.
     *
     * This used to discard the token on *any* failure of `/me` — the comment
     * even said "whatever the reason". So a backend hiccup logged the person
     * out: the read fails, the token is thrown away, `session` goes null, and
     * the router sends them to /login holding a credential that was still
     * perfectly valid. On a laptop whose database tunnel drops every few
     * minutes that is a sign-in, a few minutes of work, and a sign-in again.
     *
     * A 401 is the one answer that means the token is genuinely no good — it
     * is the server rejecting the credential rather than failing to check it.
     * Everything else is a broken request, and a broken request is not a
     * statement about who you are. Those get retried, and if they keep
     * failing the token is kept so a reload recovers the session instead of
     * demanding the password again.
     */
    const bootstrap = async () => {
      if (!token) {
        setSession(null);
        setLoading(false);
        return;
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await fetchSession(token);
          if (live) { setUnreachable(false); setLoading(false); }
          return;
        } catch (e) {
          if (!live) return;
          if (e instanceof ApiError && e.status === 401) {
            persistToken(null);
            setSession(null);
            setUnreachable(false);
            setLoading(false);
            return;
          }
          // Transient: back off and ask again before giving up on the attempt,
          // not on the credential.
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
          }
        }
      }
      if (live) { setUnreachable(true); setLoading(false); }
    };

    void bootstrap();
    return () => { live = false; };
  }, [token, fetchSession, persistToken]);

  const loginWithPassword = useCallback(async (email: string, password: string) => {
    setSigningIn(true);
    try {
      const result = await api.post<{ token: string }>(
        '/api/desktop/auth/login',
        { email, password },
        undefined,
        { quiet: true },
      );
      persistToken(result.token);
      await fetchSession(result.token);
    } catch (e) {
      // Re-phrased for the person reading it. The server says the same thing to
      // an unknown email and a wrong password on purpose, and 403 is the one
      // case where the account is real but has nowhere to go.
      if (e instanceof ApiError && e.status === 403) {
        throw new Error('That account is not part of any active workspace. Ask an admin to invite you.');
      }
      if (e instanceof ApiError && e.status === 401) {
        throw new Error('Those details did not match an account.');
      }
      throw e;
    } finally {
      setSigningIn(false);
    }
  }, [fetchSession, persistToken]);

  const loginWithLark = useCallback(async () => {
    setSigningIn(true);
    try {
      const issued = await runLarkPopupFlow();
      persistToken(issued);
      await fetchSession(issued);
    } finally {
      setSigningIn(false);
    }
  }, [fetchSession, persistToken]);

  /**
   * Re-reads the session. Safe to call from a retry button.
   *
   * Swallows a transient failure rather than throwing: the "cannot reach
   * Divo" screen calls this, and an unhandled rejection there would be a
   * button that appears to do nothing. A 401 is still honoured — if the
   * server rejects the credential, the sign-out is real.
   */
  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      await fetchSession(token);
      setUnreachable(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        persistToken(null);
        setSession(null);
        setUnreachable(false);
        return;
      }
      setUnreachable(true);
    }
  }, [token, fetchSession, persistToken]);

  const logout = useCallback(async () => {
    if (token) {
      try {
        await api.post('/api/desktop/auth/logout', {}, token, { quiet: true });
      } catch {
        // Revoking server-side is best effort. Dropping the token locally is
        // the part the person actually asked for.
      }
    }
    persistToken(null);
    setSession(null);
  }, [token, persistToken]);

  const scopes = useMemo(() => (session ? scopesFor(session) : []), [session]);

  const value = useMemo<AdminAuthContextValue>(
    () => ({
      token, session, scopes, loading, unreachable, signingIn,
      loginWithPassword, loginWithLark, refresh, logout,
    }),
    [token, session, scopes, loading, unreachable, signingIn, loginWithPassword, loginWithLark, refresh, logout],
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
