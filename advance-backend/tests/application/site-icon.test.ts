import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { iconHrefsIn, normalizeDomain } from '../../src/application/icons/site-icon.service.ts';

describe('the domain an anonymous caller is allowed to ask about', () => {
  it('accepts ordinary hostnames and lowercases them', () => {
    assert.equal(normalizeDomain('Reuters.com'), 'reuters.com');
    assert.equal(normalizeDomain('  news.bbc.co.uk '), 'news.bbc.co.uk');
    // A trailing dot is a fully-qualified name and the same site.
    assert.equal(normalizeDomain('example.com.'), 'example.com');
  });

  it('refuses anything that is not plainly a hostname', () => {
    /* This value becomes the host of an outbound request, so it is an allowlist
       of shapes rather than an escaping problem. */
    for (const raw of [
      '', 'localhost', 'example', 'exa mple.com', 'example.com/../etc', 'http://example.com',
      'exam;ple.com', 'example.com:8080', '-example.com', 'example-.com', 'exa_mple.com',
      '.example.com', 'example..com', 'user@example.com',
    ]) {
      assert.equal(normalizeDomain(raw), null, raw);
    }
  });

  it('refuses an IP address wearing a domain’s clothes', () => {
    // `127.0.0.1` is label-legal — digits and dots — so the numeric-TLD rule is
    // what keeps it out before it reaches the fetcher's own refusal.
    assert.equal(normalizeDomain('127.0.0.1'), null);
    assert.equal(normalizeDomain('169.254.169.254'), null);
  });

  it('refuses a name too long to be real', () => {
    assert.equal(normalizeDomain(`${'a'.repeat(64)}.com`), null);
    assert.equal(normalizeDomain(`${'a.'.repeat(200)}com`), null);
  });
});

describe('reading a page’s declared icons', () => {
  const base = new URL('https://example.com/');

  it('resolves relative hrefs against the page that declared them', () => {
    const found = iconHrefsIn('<link rel="icon" href="/static/fav.png">', base);
    assert.deepEqual(found, ['https://example.com/static/fav.png']);
  });

  it('prefers the largest size a tag claims', () => {
    const html = `
      <link rel="icon" sizes="16x16" href="/small.png">
      <link rel="icon" sizes="180x180" href="/big.png">
      <link rel="icon" sizes="32x32" href="/mid.png">`;
    assert.deepEqual(iconHrefsIn(html, base).slice(0, 2), [
      'https://example.com/big.png',
      'https://example.com/mid.png',
    ]);
  });

  it('puts apple-touch-icon last however big it is', () => {
    /* It is usually the cleanest image on the page and the wrong one: square,
       padded for a home screen, and visibly the wrong shape beside 12px text. */
    const html = `
      <link rel="apple-touch-icon" sizes="180x180" href="/touch.png">
      <link rel="icon" sizes="32x32" href="/fav.png">`;
    assert.deepEqual(iconHrefsIn(html, base), [
      'https://example.com/fav.png',
      'https://example.com/touch.png',
    ]);
  });

  it('reads the rel list rather than matching the whole attribute', () => {
    // `rel="shortcut icon"` is two tokens and the most common spelling of all.
    const html = `<link rel="shortcut icon" type="image/x-icon" href="favicon.ico">`;
    assert.deepEqual(iconHrefsIn(html, base), ['https://example.com/favicon.ico']);
  });

  it('ignores links that are not icons', () => {
    const html = `
      <link rel="stylesheet" href="/app.css">
      <link rel="canonical" href="https://example.com/home">
      <link rel="preload" as="image" href="/hero.png">`;
    assert.deepEqual(iconHrefsIn(html, base), []);
  });

  it('says nothing rather than failing on a page it cannot read', () => {
    // A malformed page costs a missing icon, which the monogram covers.
    assert.deepEqual(iconHrefsIn('', base), []);
    assert.deepEqual(iconHrefsIn('<link rel="icon">', base), []);
    // Unparseable even with a base to resolve against.
    assert.deepEqual(iconHrefsIn('<link rel="icon" href="http://[">', base), []);
  });

  it('cannot be talked off the page’s own origin by a junk href', () => {
    /* Nonsense resolves as a path rather than throwing, so a bad href produces
       a harmless same-origin URL rather than a skip. Worth pinning: it is the
       reason a page cannot use this to aim the fetcher somewhere else. */
    assert.deepEqual(iconHrefsIn('<link rel="icon" href="::::">', base), [
      'https://example.com/::::',
    ]);
  });

  it('does not offer the same icon twice', () => {
    const html = `
      <link rel="icon" href="/fav.png">
      <link rel="shortcut icon" href="/fav.png">`;
    assert.deepEqual(iconHrefsIn(html, base), ['https://example.com/fav.png']);
  });
});
