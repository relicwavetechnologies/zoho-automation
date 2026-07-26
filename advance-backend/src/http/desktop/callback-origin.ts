/**
 * OAuth callbacks must return to the backend the Desktop actually selected on
 * its sign-in screen, not to a machine-wide `.env` value that may still point
 * at a deployed environment. Desktop stores that URL as `divo.backendUrl` and
 * calls the backend with it, so the request's Host header *is* the operator's
 * choice — but a Host header is client-controlled, and for providers that
 * register redirect URIs dynamically (Airtable, Canva) an unvetted host would
 * be registered and could receive a real authorization code. The allowlist is
 * what makes trusting the request safe.
 */

/** Loopback means the operator is running their own backend; nothing to vet. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

export type CallbackOriginSource = 'loopback' | 'allowlist' | 'fallback';

export interface CallbackOriginResolution {
  readonly origin: string;
  readonly source: CallbackOriginSource;
}

/**
 * Parse `BACKEND_PUBLIC_URL_ALLOWLIST` — a comma-separated list of full
 * origins. Entries carry their own scheme on purpose (see resolveCallbackOrigin).
 * A malformed entry is skipped rather than fatal so one typo cannot take every
 * other backend origin offline.
 */
export function parseCallbackOriginAllowlist(raw: string | undefined | null): readonly string[] {
  if (!raw) return [];
  const origins: string[] = [];
  for (const entry of raw.split(',')) {
    const origin = safeOrigin(entry);
    if (origin && !origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/**
 * Resolve the origin an OAuth callback should be built on.
 *
 * The allowlist is matched on **host only**, and the matched entry's own origin
 * is returned. The scheme therefore always comes from configuration and never
 * from the request, so a TLS-terminating proxy that forwards plain http cannot
 * silently downgrade an https callback — which would fail the `isConfigured()`
 * https check on the MCP OAuth services and take the whole feature dark.
 */
export function resolveCallbackOrigin(input: {
  readonly host: string | undefined;
  readonly protocol: string;
  readonly allowlist: readonly string[];
  readonly fallbackUrl: string;
}): CallbackOriginResolution {
  const fallback = safeOrigin(input.fallbackUrl) ?? input.fallbackUrl.trim().replace(/\/+$/, '');
  if (!input.host) return { origin: fallback, source: 'fallback' };

  const protocol = input.protocol === 'https' ? 'https' : 'http';
  let requestUrl: URL;
  try {
    requestUrl = new URL(`${protocol}://${input.host}`);
  } catch {
    return { origin: fallback, source: 'fallback' };
  }

  if (isLoopbackHost(requestUrl.hostname)) {
    return { origin: requestUrl.origin, source: 'loopback' };
  }

  const allowed = input.allowlist.find((origin) => hostOf(origin) === requestUrl.host);
  if (allowed) return { origin: allowed, source: 'allowlist' };

  // The configured public URL is implicitly allowlisted, so a deployment that
  // never sets an allowlist keeps working exactly as it did before.
  if (hostOf(fallback) === requestUrl.host) return { origin: fallback, source: 'allowlist' };

  return { origin: fallback, source: 'fallback' };
}

/** Host header, normalised past Node's `string | string[]` typing. */
export function requestHost(headers: { host?: string | string[] | undefined }): string | undefined {
  const host = headers.host;
  return Array.isArray(host) ? host[0] : host;
}
