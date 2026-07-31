import {
  buildOmsProviderRequest,
  type OmsFetchedData,
  type OmsProviderRequest,
  type OmsSiteDataToolArgs,
  OmsSiteDataServiceError,
} from '../../application/oms/oms-site-data.types';

export const OMS_SITE_DATA_READ_URL = 'https://agents.outreachdeal.com/webhook/site_data_read_only';
const PROVIDER_ROW_CAP = 100;

/** Fixed-host client for the reviewed OMS Site Data webhook. */
export class OmsSiteDataClient {
  constructor(private readonly deps: { timeoutMs: number; fetchImpl?: typeof fetch; endpoint?: string }) {}

  async verifyKey(apiKey: string): Promise<void> {
    const response = await this.request(apiKey, { columns: ['website'] });
    // A non-empty JSON array proves both the key and current read contract.
    await parseRows(response);
  }

  async fetch(apiKey: string, args: OmsSiteDataToolArgs): Promise<OmsFetchedData> {
    const response = await this.request(apiKey, buildOmsProviderRequest(args));
    let rows = await parseRows(response);
    if (args.operation === 'list_catalog_values') {
      rows = rows.sort((left, right) => String(left[args.field] ?? '').localeCompare(String(right[args.field] ?? ''), undefined, { sensitivity: 'base' }));
    }
    return {
      operation: args.operation,
      status: rows.length === 0 ? 'empty' : rows.length === PROVIDER_ROW_CAP ? 'partial' : 'complete',
      coverage: {
        source: 'OMS Site Data Read API',
        providerRowCap: PROVIDER_ROW_CAP,
        returnedRows: rows.length,
        ...(rows.length === PROVIDER_ROW_CAP ? { possiblyTruncated: true } : {}),
      },
      rows,
    };
  }

  private async request(apiKey: string, payload: OmsProviderRequest): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    try {
      const response = await (this.deps.fetchImpl ?? fetch)(this.deps.endpoint ?? OMS_SITE_DATA_READ_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (response.ok) return response;
      if (response.status === 401 || response.status === 403) {
        throw new OmsSiteDataServiceError('provider_auth_failed', 'OMS rejected the configured Site Data API key.');
      }
      throw new OmsSiteDataServiceError('provider_failure', `OMS Site Data request failed with HTTP ${response.status}.`);
    } catch (error) {
      if (error instanceof OmsSiteDataServiceError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new OmsSiteDataServiceError('timeout', 'OMS Site Data request timed out; no retry was attempted.');
      }
      throw new OmsSiteDataServiceError('provider_failure', 'OMS Site Data request could not be completed.');
    } finally {
      clearTimeout(timer);
    }
  }
}

async function parseRows(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  // The current webhook returns HTTP 200 with an empty body for both invalid
  // input and no-match. Divo prevalidates all requests, but must still not
  // tell users that an empty body means "no sites found".
  if (!text.trim()) {
    throw new OmsSiteDataServiceError(
      'ambiguous_empty_response',
      'OMS returned an empty response body, which its current contract cannot distinguish between no matches and a rejected request.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OmsSiteDataServiceError('provider_failure', 'OMS returned malformed JSON.');
  }
  // The webhook signals a rejected key as HTTP 200 with an error envelope
  // object rather than a 401/403, so status codes alone cannot classify it.
  if (isRecord(parsed) && parsed.success === false) {
    const reason = typeof parsed.error === 'string' ? parsed.error : '';
    // Classify on `error` only. Misreading a validation failure as an auth
    // failure marks the company connection unavailable for 15 minutes and
    // pages admins, so the human-readable `message` — which may mention the
    // API key for unrelated reasons — must not drive this decision.
    if (/unauthor|forbidden/i.test(reason)) {
      throw new OmsSiteDataServiceError('provider_auth_failed', 'OMS rejected the configured Site Data API key.');
    }
    throw new OmsSiteDataServiceError('provider_failure', `OMS rejected the request${reason ? `: ${reason}` : '.'}`);
  }
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    throw new OmsSiteDataServiceError('provider_failure', 'OMS returned a response outside its documented JSON-array contract.');
  }
  if (parsed.length > PROVIDER_ROW_CAP) {
    throw new OmsSiteDataServiceError('provider_failure', 'OMS exceeded its documented 100-row response cap.');
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
