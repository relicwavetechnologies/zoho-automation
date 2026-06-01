import { create } from 'zustand';
import { exchangeLarkCode, fetchMe, getLarkAuthorizeUrl, logout, pollLarkCallback } from '@/lib/api';
import { openExternal, onDeepLink } from '@/lib/tauri';
import { STORAGE_KEYS } from '@/lib/config';
import type { ApiSession } from '@/lib/api';

export type OnboardingStep = 'login' | 'greeting' | 'workspace' | 'done';
export type AuthStatus = 'loading' | 'idle' | 'authenticating' | 'error';

interface AuthState {
  session: ApiSession | null;
  status: AuthStatus;
  onboardingStep: OnboardingStep;
  error: string | null;
  pollAbort: AbortController | null;

  hydrate: () => Promise<void>;
  startLarkSignIn: () => Promise<void>;
  consumeDeepLink: (url: string) => Promise<void>;
  setOnboardingStep: (step: OnboardingStep) => void;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  status: 'loading',
  onboardingStep: 'login',
  error: null,
  pollAbort: null,

  hydrate: async () => {
    const raw = localStorage.getItem(STORAGE_KEYS.session);
    const step = (localStorage.getItem(STORAGE_KEYS.onboardingStep) as OnboardingStep) ?? 'login';
    if (!raw) {
      set({ session: null, status: 'idle', onboardingStep: 'login' });
      return;
    }

    let parsed: ApiSession;
    try {
      parsed = JSON.parse(raw) as ApiSession;
    } catch {
      localStorage.removeItem(STORAGE_KEYS.session);
      set({ session: null, status: 'idle', onboardingStep: 'login' });
      return;
    }

    // Optimistically restore the saved session right away so the user stays
    // logged in across restarts — even if the backend is briefly unreachable
    // at boot (e.g. it's mid-reload). We validate in the background below.
    set({
      session: parsed,
      status: 'idle',
      onboardingStep: step === 'login' ? 'done' : step,
    });

    const me = await fetchMe(parsed.token);
    if (me.success && me.data) {
      set({ session: { token: parsed.token, user: me.data } });
      return;
    }

    // Only sign out on a DEFINITIVE auth rejection — never on a network blip,
    // 5xx, or the backend being temporarily down.
    const code = me.error?.code ?? '';
    if (code === 'HTTP_401' || code === 'HTTP_403') {
      localStorage.removeItem(STORAGE_KEYS.session);
      localStorage.removeItem(STORAGE_KEYS.onboardingStep);
      set({ session: null, status: 'idle', onboardingStep: 'login' });
    }
    // Otherwise keep the optimistically-restored session as-is.
  },

  startLarkSignIn: async () => {
    const existingSession = get().session;
    const previousStep = get().onboardingStep;
    set({ status: 'authenticating', error: null });

    const urlRes = await getLarkAuthorizeUrl();
    if (!urlRes.success || !urlRes.data) {
      set({ status: 'error', error: urlRes.error?.message ?? 'Failed to start Lark sign-in' });
      return;
    }
    const { authorizeUrl, nonce } = urlRes.data;

    // Open the consent page in the system browser
    await openExternal(authorizeUrl);

    // Cancel any previous polling loop
    get().pollAbort?.abort();
    const abort = new AbortController();
    set({ pollAbort: abort });

    // Polling loop: backend stores the callback by nonce; we drain it.
    // ~120s window with 2s interval matches the existing Electron implementation.
    for (let i = 0; i < 60; i++) {
      if (abort.signal.aborted) return;
      await sleep(2_000);
      const pollRes = await pollLarkCallback(nonce);
      if (pollRes.success && pollRes.data?.code && pollRes.data?.state) {
        const exch = await exchangeLarkCode({ code: pollRes.data.code, state: pollRes.data.state });
        if (!exch.success || !exch.data) {
          set({
            status: 'error',
            error: exch.error?.message ?? 'Token exchange failed',
            pollAbort: null,
          });
          return;
        }
        const nextStep = existingSession
          ? (previousStep === 'login' ? 'done' : previousStep)
          : 'greeting';
        localStorage.setItem(STORAGE_KEYS.session, JSON.stringify(exch.data));
        localStorage.setItem(STORAGE_KEYS.onboardingStep, nextStep);
        set({
          session: exch.data,
          status: 'idle',
          onboardingStep: nextStep,
          pollAbort: null,
        });
        return;
      }
    }
    set({
      status: 'error',
      error: 'Sign-in timed out. Please try again.',
      pollAbort: null,
    });
  },

  consumeDeepLink: async (url: string) => {
    // Parse a divo://auth/callback?code=...&state=... deep link.
    try {
      const u = new URL(url);
      if (u.protocol !== 'divo:' || !u.pathname.startsWith('/auth/callback') && u.host !== 'auth') {
        return;
      }
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      if (!code || !state) return;
      const existingSession = get().session;
      const previousStep = get().onboardingStep;
      get().pollAbort?.abort();
      const exch = await exchangeLarkCode({ code, state });
      if (!exch.success || !exch.data) {
        set({ status: 'error', error: exch.error?.message ?? 'Token exchange failed' });
        return;
      }
      const nextStep = existingSession
        ? (previousStep === 'login' ? 'done' : previousStep)
        : 'greeting';
      localStorage.setItem(STORAGE_KEYS.session, JSON.stringify(exch.data));
      localStorage.setItem(STORAGE_KEYS.onboardingStep, nextStep);
      set({ session: exch.data, status: 'idle', onboardingStep: nextStep, pollAbort: null });
    } catch {
      // ignore — malformed deep link
    }
  },

  setOnboardingStep: (step) => {
    localStorage.setItem(STORAGE_KEYS.onboardingStep, step);
    set({ onboardingStep: step });
  },

  signOut: async () => {
    const { session } = get();
    if (session) {
      await logout(session.token).catch(() => undefined);
    }
    localStorage.removeItem(STORAGE_KEYS.session);
    localStorage.removeItem(STORAGE_KEYS.onboardingStep);
    set({ session: null, status: 'idle', onboardingStep: 'login' });
  },
}));

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Wire deep-link handler once at module load (no React reactivity needed).
void onDeepLink(({ url }) => {
  void useAuthStore.getState().consumeDeepLink(url);
});
