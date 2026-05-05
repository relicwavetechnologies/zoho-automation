const LARK_API_BASE = 'https://open.larksuite.com';
const TOKEN_URL = `${LARK_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`;
const REQUEST_TIMEOUT_MS = 12_000;

export interface LarkHttpClientDeps {
  appId: string;
  appSecret: string;
  /** Pre-resolved user access token. If set, bypasses tenant token fetch entirely. */
  userToken?: string;
}

export class LarkApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'LarkApiError';
  }
}

export class LarkHttpClient {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly fixedUserToken: string | undefined;
  private token?: string;
  private tokenExpiresAt = 0;
  /** Deduplicate concurrent refresh calls — all waiters share one in-flight fetch. */
  private tokenRefreshPromise: Promise<string> | undefined;

  constructor(deps: LarkHttpClientDeps) {
    this.appId = deps.appId;
    this.appSecret = deps.appSecret;
    this.fixedUserToken = deps.userToken;
  }

  async request<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    opts?: { query?: Record<string, string | number | string[] | undefined>; body?: unknown },
  ): Promise<T> {
    const token = await this.getToken();

    const url = new URL(`${LARK_API_BASE}${path}`);
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          v.forEach(item => url.searchParams.append(k, item));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const bodyStr = opts?.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(bodyStr !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(bodyStr !== undefined ? { body: bodyStr } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const payload = await res.json().catch(() => ({})) as Record<string, unknown>;

    if (!res.ok || (typeof payload['code'] === 'number' && payload['code'] !== 0)) {
      const msg = (payload['msg'] as string | undefined) ?? (payload['message'] as string | undefined) ?? `HTTP ${res.status}`;
      const detail = JSON.stringify(payload);
      throw new LarkApiError(`${msg} — ${detail}`, res.status, payload['code'] as number | undefined);
    }

    return (payload['data'] ?? payload) as T;
  }

  private async getToken(): Promise<string> {
    if (this.fixedUserToken) return this.fixedUserToken;
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.token;
    }
    // If a refresh is already in-flight, all concurrent callers share that same
    // promise. This prevents multiple simultaneous token fetches that would race
    // to overwrite this.token, causing some callers to hold a token that has since
    // been superseded and rejected by Lark (error 99991663).
    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }
    this.tokenRefreshPromise = this.fetchNewToken().finally(() => {
      this.tokenRefreshPromise = undefined;
    });
    return this.tokenRefreshPromise;
  }

  private async fetchNewToken(): Promise<string> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || data['code'] !== 0) {
      throw new LarkApiError(`Failed to get tenant token: ${JSON.stringify(data)}`, res.status);
    }
    this.token = data['tenant_access_token'] as string;
    this.tokenExpiresAt = Date.now() + ((data['expire'] as number) * 1000);
    return this.token;
  }
}
