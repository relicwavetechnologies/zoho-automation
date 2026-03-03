"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";

import {
  authLogin,
  authMe,
  authRegister,
  authSessionBootstrap,
} from "@/lib/api";
import { clearStoredToken, getStoredToken, setStoredToken } from "@/lib/auth";
import type { Capabilities, Membership, Organization, User } from "@/types";

interface AuthContextValue {
  user: User | null;
  organization: Organization | null;
  membership: Membership | null;
  capabilities: Capabilities;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (
    first_name: string,
    last_name: string,
    email: string,
    password: string
  ) => Promise<void>;
  completeOAuthLogin: (token: string) => Promise<void>;
  refreshSession: () => Promise<void>;
  logout: () => void;
  isLoading: boolean;
}

const EMPTY_CAPABILITIES: Capabilities = {
  tools_allowed: [],
  tools_blocked: [],
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [membership, setMembership] = useState<Membership | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities>(EMPTY_CAPABILITIES);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadSession = useCallback(async (sessionToken: string) => {
    try {
      const bootstrap = await authSessionBootstrap(sessionToken);
      setToken(sessionToken);
      setUser(bootstrap.user);
      setOrganization(bootstrap.organization);
      setMembership(bootstrap.membership);
      setCapabilities(bootstrap.capabilities || EMPTY_CAPABILITIES);
    } catch {
      const me = await authMe(sessionToken);
      setToken(sessionToken);
      setUser(me);
      setOrganization(null);
      setMembership(null);
      setCapabilities(EMPTY_CAPABILITIES);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      const storedToken = getStoredToken();
      if (!storedToken) {
        if (mounted) setIsLoading(false);
        return;
      }

      try {
        await loadSession(storedToken);
      } catch {
        clearStoredToken();
        if (!mounted) return;
        setToken(null);
        setUser(null);
        setOrganization(null);
        setMembership(null);
        setCapabilities(EMPTY_CAPABILITIES);
      } finally {
        if (mounted) setIsLoading(false);
      }
    };

    void load();

    return () => {
      mounted = false;
    };
  }, [loadSession]);

  const login = useCallback(async (email: string, password: string) => {
    const response = await authLogin(email, password);
    setStoredToken(response.token);
    await loadSession(response.token);
  }, [loadSession]);

  const register = useCallback(
    async (
      first_name: string,
      last_name: string,
      email: string,
      password: string
    ) => {
      const response = await authRegister(first_name, last_name, email, password);
      setStoredToken(response.token);
      await loadSession(response.token);
    },
    [loadSession]
  );

  const completeOAuthLogin = useCallback(
    async (sessionToken: string) => {
      setStoredToken(sessionToken);
      await loadSession(sessionToken);
    },
    [loadSession]
  );

  const refreshSession = useCallback(async () => {
    const currentToken = token || getStoredToken();
    if (!currentToken) return;
    await loadSession(currentToken);
  }, [token, loadSession]);

  const logout = useCallback(() => {
    clearStoredToken();
    setToken(null);
    setUser(null);
    setOrganization(null);
    setMembership(null);
    setCapabilities(EMPTY_CAPABILITIES);
    router.push("/login");
  }, [router]);

  const value = useMemo(
    () => ({
      user,
      organization,
      membership,
      capabilities,
      token,
      login,
      register,
      completeOAuthLogin,
      refreshSession,
      logout,
      isLoading,
    }),
    [
      user,
      organization,
      membership,
      capabilities,
      token,
      login,
      register,
      completeOAuthLogin,
      refreshSession,
      logout,
      isLoading,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
