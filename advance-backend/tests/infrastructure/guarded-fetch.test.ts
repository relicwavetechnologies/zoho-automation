import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFetchableUrl,
  isBlockedAddress,
  guardedFetch,
} from '../../src/infrastructure/http/guarded-fetch.ts';

/**
 * A guard like this is the kind of code that looks right while being open, so
 * these cover the two bypasses that defeat the usual implementation and the
 * ranges that are easiest to leave out.
 */
describe('addresses this process must not be talked into reaching', () => {
  it('blocks the cloud metadata endpoint', () => {
    // The one that actually costs you the instance's credentials.
    assert.equal(isBlockedAddress('169.254.169.254'), true);
  });

  it('blocks every private and reserved IPv4 range', () => {
    for (const address of [
      '0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.1.1', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '192.0.0.1', '100.64.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    ]) {
      assert.equal(isBlockedAddress(address), true, address);
    }
  });

  it('allows ordinary public addresses', () => {
    // 172.15 and 172.32 sit either side of the RFC1918 block — an off-by-one
    // here quietly blocks a chunk of the real internet.
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.0.1']) {
      assert.equal(isBlockedAddress(address), false, address);
    }
  });

  it('blocks the IPv6 equivalents, including IPv4 in disguise', () => {
    for (const address of [
      '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
      // The bypass worth naming: same machine, different notation.
      '::ffff:127.0.0.1', '::ffff:169.254.169.254',
    ]) {
      assert.equal(isBlockedAddress(address), true, address);
    }
    assert.equal(isBlockedAddress('2606:4700:4700::1111'), false);
  });

  it('refuses anything it cannot parse rather than passing it through', () => {
    // This answer is used to allow traffic, so unknown has to mean no.
    assert.equal(isBlockedAddress('not-an-address'), true);
    assert.equal(isBlockedAddress(''), true);
  });
});

describe('URLs refused before a packet is sent', () => {
  it('refuses an address literal, which no DNS guard can catch', () => {
    /* The whole reason this check exists. A `lookup` hook never runs when there
       is no name to resolve, so a guard built only on DNS — which is the shape
       every write-up recommends — is wide open to exactly these. */
    for (const raw of [
      'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5:6379/', 'http://[::1]/', 'https://192.168.0.1/favicon.ico',
    ]) {
      assert.equal(assertFetchableUrl(raw).ok, false, raw);
    }
  });

  it('refuses schemes that read something the caller cannot', () => {
    for (const raw of ['file:///etc/passwd', 'data:text/html,x', 'gopher://x.com/', 'ftp://x.com/']) {
      assert.equal(assertFetchableUrl(raw).ok, false, raw);
    }
  });

  it('refuses credentials smuggled into the host', () => {
    assert.equal(assertFetchableUrl('https://user:pass@example.com/').ok, false);
  });

  it('refuses names that only mean something inside this network', () => {
    for (const raw of [
      'http://localhost/', 'http://api.localhost/', 'http://printer.local/',
      'http://vault.internal/', 'http://thing.home.arpa/',
    ]) {
      assert.equal(assertFetchableUrl(raw).ok, false, raw);
    }
  });

  it('allows an ordinary website', () => {
    const result = assertFetchableUrl('https://reuters.com/world');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.hostname, 'reuters.com');
  });
});

describe('the fetch itself', () => {
  it('applies the same refusal it would apply to a redirect target', async () => {
    /* Per-hop revalidation is structural — `guardedFetch` runs
       `assertFetchableUrl` at the top of every iteration, so hop two is checked
       by the code proven above. It cannot be exercised end to end here: every
       server this test could start is on a loopback address, which is refused
       before the request is built. That refusal is what this pins. */
    const refused = await guardedFetch('http://169.254.169.254/latest/meta-data/', {
      accept: ['text/html'], maxBytes: 1_000, timeoutMs: 500, maxRedirects: 3,
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.reason, 'unsafe_url');
  });

  it('never throws, however hostile the input', async () => {
    // Callers look up icons for domains they have never seen. Being refused is
    // the normal case, and an exception is the wrong shape for the normal case.
    for (const raw of ['', 'not a url', 'file:///etc/passwd', 'http://[::1]/']) {
      const result = await guardedFetch(raw, {
        accept: ['image/'], maxBytes: 100, timeoutMs: 200, maxRedirects: 0,
      });
      assert.equal(result.ok, false, raw);
    }
  });
});
