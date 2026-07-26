import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCallbackOriginAllowlist,
  requestHost,
  resolveCallbackOrigin,
} from '../../src/http/desktop/callback-origin.ts';

const FALLBACK = 'http://localhost:8000';
const ALLOWLIST = parseCallbackOriginAllowlist(
  'https://app-dev.103.172.92.187.sslip.io, https://app.divo.test/',
);

describe('parseCallbackOriginAllowlist', () => {
  it('normalises entries to bare origins and drops trailing paths', () => {
    assert.deepEqual(
      parseCallbackOriginAllowlist('https://a.test/api/, https://b.test'),
      ['https://a.test', 'https://b.test'],
    );
  });

  it('skips malformed entries instead of failing the whole list', () => {
    assert.deepEqual(parseCallbackOriginAllowlist('not a url, https://ok.test'), ['https://ok.test']);
  });

  it('deduplicates origins that differ only by path or trailing slash', () => {
    assert.deepEqual(parseCallbackOriginAllowlist('https://a.test/,https://a.test/callback'), ['https://a.test']);
  });

  it('treats an unset allowlist as empty', () => {
    assert.deepEqual(parseCallbackOriginAllowlist(undefined), []);
    assert.deepEqual(parseCallbackOriginAllowlist(''), []);
  });
});

describe('resolveCallbackOrigin', () => {
  it('uses the allowlisted origin when the desktop signed in against it', () => {
    assert.deepEqual(
      resolveCallbackOrigin({
        host: 'app-dev.103.172.92.187.sslip.io',
        protocol: 'http',
        allowlist: ALLOWLIST,
        fallbackUrl: FALLBACK,
      }),
      { origin: 'https://app-dev.103.172.92.187.sslip.io', source: 'allowlist' },
    );
  });

  it('keeps https from the allowlist even when a TLS-terminating proxy forwards http', () => {
    // The whole feature goes dark if this downgrades: the MCP OAuth services
    // refuse a non-https callback.
    const resolved = resolveCallbackOrigin({
      host: 'app.divo.test',
      protocol: 'http',
      allowlist: ALLOWLIST,
      fallbackUrl: FALLBACK,
    });
    assert.equal(resolved.origin, 'https://app.divo.test');
  });

  it('trusts loopback hosts without an allowlist entry', () => {
    assert.deepEqual(
      resolveCallbackOrigin({
        host: 'localhost:8000',
        protocol: 'http',
        allowlist: [],
        fallbackUrl: 'https://deployed.test',
      }),
      { origin: 'http://localhost:8000', source: 'loopback' },
    );
  });

  it('does not follow a host that is absent from the allowlist', () => {
    assert.deepEqual(
      resolveCallbackOrigin({
        host: 'evil.test',
        protocol: 'https',
        allowlist: ALLOWLIST,
        fallbackUrl: FALLBACK,
      }),
      { origin: FALLBACK, source: 'fallback' },
    );
  });

  it('matches on host including port, so a different port is not allowlisted', () => {
    assert.equal(
      resolveCallbackOrigin({
        host: 'app.divo.test:9999',
        protocol: 'https',
        allowlist: ALLOWLIST,
        fallbackUrl: FALLBACK,
      }).source,
      'fallback',
    );
  });

  it('implicitly allowlists the configured public URL for deployments with no allowlist', () => {
    assert.deepEqual(
      resolveCallbackOrigin({
        host: 'deployed.test',
        protocol: 'https',
        allowlist: [],
        fallbackUrl: 'https://deployed.test',
      }),
      { origin: 'https://deployed.test', source: 'allowlist' },
    );
  });

  it('falls back when the request carries no Host header', () => {
    assert.deepEqual(
      resolveCallbackOrigin({
        host: undefined,
        protocol: 'https',
        allowlist: ALLOWLIST,
        fallbackUrl: FALLBACK,
      }),
      { origin: FALLBACK, source: 'fallback' },
    );
  });
});

describe('requestHost', () => {
  it('collapses the string-or-array Host header typing', () => {
    assert.equal(requestHost({ host: 'a.test' }), 'a.test');
    assert.equal(requestHost({ host: ['a.test', 'b.test'] }), 'a.test');
    assert.equal(requestHost({}), undefined);
  });
});
