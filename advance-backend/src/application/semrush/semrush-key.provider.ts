import { SemrushServiceError } from './semrush.types';

/**
 * Where a Semrush API key comes from, and what happens when one is spent.
 *
 * Semrush keys exhaust in ordinary use — a key answered ten requests and was
 * refused on the eleventh during the 2026-08-08 investigation. The webhook is
 * the source of truth for which key is currently live, and it has been ahead of
 * the environment before: the env key was dead while the webhook was serving a
 * working one, which is the whole of that outage.
 *
 * So the environment key is the fallback, not the primary, wherever a webhook
 * is configured. A resolved key is cached until it fails, so the webhook is
 * called on the first request and then only when a key dies.
 */
export interface SemrushKeyProvider {
  /** The key to use now. */
  resolve(): Promise<string>;
  /** Report that this key was refused, so the next resolve looks again. */
  invalidate(key: string): void;
  /** Whether a fresh key could differ from the one just refused. */
  readonly canRotate: boolean;
}

export function createSemrushKeyProvider(deps: {
  readonly environmentApiKey?: string;
  readonly webhookUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs: number;
}): SemrushKeyProvider {
  const environmentKey = deps.environmentApiKey?.trim() ?? '';
  const webhookUrl = deps.webhookUrl?.trim() ?? '';

  let cached: string | undefined;
  /** Shared so concurrent first requests make one webhook call, not several. */
  let inFlight: Promise<string> | undefined;

  async function loadFromWebhook(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    try {
      const response = await (deps.fetchImpl ?? fetch)(webhookUrl, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new SemrushServiceError('provider_failure', `Semrush key webhook failed with HTTP ${response.status}.`);
      }
      const payload = await response.json() as unknown;
      const record = Array.isArray(payload) ? payload[0] : payload;
      const key = typeof (record as { api_key?: unknown })?.api_key === 'string'
        ? (record as { api_key: string }).api_key.trim()
        : '';
      const status = (record as { status?: unknown })?.status;
      if (status !== 'active' || !key) {
        throw new SemrushServiceError('not_configured', 'Semrush key webhook returned no active API key.');
      }
      return key;
    } catch (error) {
      if (error instanceof SemrushServiceError) throw error;
      throw new SemrushServiceError('provider_failure', 'Semrush key webhook could not be reached.');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    canRotate: Boolean(webhookUrl),

    async resolve(): Promise<string> {
      if (cached) return cached;
      if (!webhookUrl) {
        if (!environmentKey) {
          throw new SemrushServiceError(
            'not_configured',
            'Semrush is not configured. Set SEMRUSH_WEB_API_KEY in the backend environment.',
          );
        }
        cached = environmentKey;
        return cached;
      }
      // A webhook that is down must not take Semrush down with it while a
      // usable environment key exists.
      inFlight ??= loadFromWebhook().catch((error) => {
        if (environmentKey) return environmentKey;
        throw error;
      });
      try {
        cached = await inFlight;
        return cached;
      } finally {
        inFlight = undefined;
      }
    },

    invalidate(key: string): void {
      if (cached && cached === key.trim()) cached = undefined;
    },
  };
}
