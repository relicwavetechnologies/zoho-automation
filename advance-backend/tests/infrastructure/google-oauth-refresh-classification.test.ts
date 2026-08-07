/**
 * Which refresh failures mean "this account is dead".
 *
 * The blast radius is why this is tested at all. A `refresh_rejected` verdict
 * writes `reauthorization_required` onto the connection, which drops it out of
 * every accessible list and tells its owner to sign in again. Get that right
 * and a revoked account finally stops pretending to work; get it wrong on a
 * config error and every Google connection in every company flips to
 * "reconnect" at once — for a fault no amount of reconnecting can fix.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GoogleOAuthService,
  GoogleTokenRefreshError,
} from '../../src/infrastructure/google/google-oauth.service.ts';

const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };
const cache: any = {
  get: async () => ({ ok: true, value: null }),
  set: async () => ({ ok: true }),
  del: async () => ({ ok: true }),
};

const service = () => new GoogleOAuthService({
  env: {
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    GOOGLE_OAUTH_REDIRECT_URI: 'https://divo.example.com/api/desktop/auth/google/callback',
    BACKEND_PUBLIC_URL: 'https://divo.example.com',
  } as never,
  cache,
  logger,
});

/** Replaces `fetch` for one call and always restores it. */
async function withTokenResponse<T>(
  status: number,
  body: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const refreshError = async (status: number, body: unknown): Promise<GoogleTokenRefreshError> => {
  const error = await withTokenResponse(status, body, async () => {
    try {
      await service().refreshAccessToken('stored-refresh-token');
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.ok(error instanceof GoogleTokenRefreshError, `expected a typed error, got ${String(error)}`);
  return error;
};

describe('Google refresh failure classification', () => {
  it('calls a revoked grant rejected, and carries Google\'s own wording', async () => {
    // The exact payload seen in production when the member's grant expired.
    const error = await refreshError(400, {
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.',
    });

    assert.equal(error.code, 'refresh_rejected');
    assert.equal(error.status, 400);
    // The reason is shown to a person, so it must be Google's sentence rather
    // than a generic fallback.
    assert.equal(error.message, 'Token has been expired or revoked.');
  });

  it('does not blame the account for this deployment\'s own credentials', async () => {
    // `invalid_client` is Divo's client id or secret being wrong. It arrives as
    // a 400 exactly like a revoked grant, applies to every connection at once,
    // and reconnecting fixes none of them — so classifying on the status code
    // rather than the error code would empty every company's Google list.
    for (const code of ['invalid_client', 'unauthorized_client', 'invalid_request']) {
      const error = await refreshError(400, { error: code });
      assert.equal(error.code, 'provider_failure', code);
    }
  });

  it('does not mark an account dead because Google was having a bad minute', async () => {
    for (const status of [429, 500, 503]) {
      const error = await refreshError(status, { error: 'backend_error' });
      assert.equal(error.code, 'provider_failure', String(status));
      assert.equal(error.status, status);
    }
  });

  it('reads the error code whatever case or padding Google sends it in', async () => {
    const error = await refreshError(400, { error: '  Invalid_Grant  ' });
    assert.equal(error.code, 'refresh_rejected');
  });

  it('treats an unparseable body as a provider fault, not a dead grant', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('<html>gateway timeout</html>', {
      status: 504,
      headers: { 'Content-Type': 'text/html' },
    })) as typeof fetch;
    try {
      await assert.rejects(
        () => service().refreshAccessToken('stored-refresh-token'),
        (e: unknown) => e instanceof GoogleTokenRefreshError && e.code === 'provider_failure',
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
