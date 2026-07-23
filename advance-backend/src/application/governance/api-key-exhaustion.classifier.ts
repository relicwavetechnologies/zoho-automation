/**
 * Shared classifier for API-key exhaustion / quota / billing failures.
 * Member policy limits (RPM, monthly budget) are NOT classified here.
 */

export type ApiKeyProvider =
  | 'serper'
  | 'deepseek'
  | 'openai_gateway'
  | 'openai'
  | 'semrush'
  | 'oms_site_data'
  | 'gemini'
  | 'openrouter'
  | 'groq'
  | 'cloudinary';

export const API_KEY_PROVIDER_LABELS: Record<ApiKeyProvider, string> = {
  serper: 'Web search (Serper)',
  deepseek: 'DeepSeek',
  openai_gateway: 'OpenAI company gateway',
  openai: 'OpenAI',
  semrush: 'Semrush',
  oms_site_data: 'OMS Site Data',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  cloudinary: 'Cloudinary',
};

/** Provider-specific codes that mean the key/credits are exhausted or unusable. */
const EXHAUSTION_CODES = new Set([
  'search_rate_limited',
  'search_auth_failed',
  'provider_insufficient_units',
  'provider_auth_failed',
  'insufficient_quota',
  'insufficient_units',
  'billing_hard_limit',
  'credits_exhausted',
]);

export type ExhaustionSignal = {
  readonly code?: string | null | undefined;
  readonly message?: string | null | undefined;
  readonly httpStatus?: number | null | undefined;
};

export function isApiKeyExhausted(signal: ExhaustionSignal): boolean {
  const code = (signal.code ?? '').trim().toLowerCase();
  if (code && EXHAUSTION_CODES.has(code)) return true;

  const status = signal.httpStatus ?? null;
  const message = (signal.message ?? '').toLowerCase();

  if (status === 402) return true;

  if (status === 401 || status === 403) {
    // Auth failures on key-backed providers usually mean revoked/invalid/exhausted keys.
    return true;
  }

  if (
    message.includes('insufficient_quota') ||
    message.includes('insufficient quota') ||
    message.includes('insufficient units') ||
    message.includes('insufficient api units') ||
    message.includes('out of credits') ||
    message.includes('no credits') ||
    (message.includes('credits') && (message.includes('exhaust') || message.includes('deplet') || message.includes('balance'))) ||
    (message.includes('billing') && (message.includes('limit') || message.includes('hard') || message.includes('exceed'))) ||
    (message.includes('quota') && (message.includes('exceed') || message.includes('exhaust') || message.includes('reached')))
  ) {
    return true;
  }

  // Bare 429 is often RPM — only treat as exhaustion when the body says so.
  if (status === 429) {
    return (
      message.includes('quota') ||
      message.includes('credit') ||
      message.includes('billing') ||
      message.includes('insufficient') ||
      message.includes('units') ||
      code === 'search_rate_limited' ||
      code === 'rate_limited'
    );
  }

  return false;
}

/** Serper: exhaustion only after the whole key pool failed (not mid-failover). */
export function isSerperPoolExhausted(lastError: ExhaustionSignal): boolean {
  const code = (lastError.code ?? '').trim().toLowerCase();
  return code === 'search_rate_limited' || code === 'search_auth_failed' || code === 'search_unavailable';
}
