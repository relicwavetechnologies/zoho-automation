/**
 * Fetch mock helpers for Lark client tests.
 *
 * Lark always returns { code: 0, data: {...} } on success.
 * The token endpoint returns { code: 0, tenant_access_token: '...', expire: 7200 }.
 */

export const TOKEN_RESPONSE = {
  code: 0,
  tenant_access_token: 'test-token-xyz',
  expire: 7200,
};

export type MockCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

/** Build a fetch mock that can be injected as globalThis.fetch. */
export function buildMockFetch(
  handlers: Array<{
    match: (url: string, method: string) => boolean;
    response: unknown;
    status?: number;
  }>,
): { fetch: typeof globalThis.fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries(init?.headers as Record<string, string> ?? {}),
    );
    let body: unknown;
    try { body = JSON.parse(init?.body as string); } catch { body = undefined; }

    calls.push({ url, method, headers, body });

    // Token endpoint
    if (url.includes('/auth/v3/tenant_access_token')) {
      return jsonResponse(TOKEN_RESPONSE);
    }

    for (const h of handlers) {
      if (h.match(url, method)) {
        return jsonResponse(h.response, h.status ?? 200);
      }
    }

    return jsonResponse({ code: 0, data: {} });
  };

  return { fetch: fetch as typeof globalThis.fetch, calls };
}

/** Build a fetch mock that always returns the given data as a Lark success response. */
export function simpleMock(data: unknown): { fetch: typeof globalThis.fetch; calls: MockCall[] } {
  return buildMockFetch([{ match: () => true, response: { code: 0, data } }]);
}

/** Fetch mock that returns a Lark API error. */
export function errorMock(msg = 'permission denied', code = 99991663): typeof globalThis.fetch {
  const f = async (): Promise<Response> => jsonResponse({ code, msg }, 200);
  return f as typeof globalThis.fetch;
}

/** Fetch mock that returns an HTTP-level error. */
export function httpErrorMock(status = 500): typeof globalThis.fetch {
  const f = async (): Promise<Response> => {
    if ((f as unknown as Record<string, unknown>)['_tokenDone']) {
      return jsonResponse({ error: 'server error' }, status);
    }
    // First call is token
    (f as unknown as Record<string, unknown>)['_tokenDone'] = true;
    return jsonResponse(TOKEN_RESPONSE);
  };
  return f as typeof globalThis.fetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
