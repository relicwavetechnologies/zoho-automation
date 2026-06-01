// Backend connection configuration.
// Override via env: VITE_API_BASE / VITE_WS_BASE
export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8000';
export const WS_BASE =
  (import.meta.env.VITE_WS_BASE as string | undefined) ??
  API_BASE.replace(/^http/, 'ws');

export const STORAGE_KEYS = {
  session: 'divo.session',
  onboardingStep: 'divo.onboarding.step',
  workspace: 'divo.workspace',
  threads: 'divo.threads',
} as const;
