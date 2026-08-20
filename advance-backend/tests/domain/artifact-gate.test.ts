import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDocument } from '../../src/domain/artifact/document.ts';
import { hashOf, newPassword } from '../../src/domain/artifact/gate.ts';

const BODY = '<section id="secret-report"><h2>Confidential report</h2><div class="chart" data-chart="{}"></div></section>';

describe('artifact gate', () => {
  it('generates passwords without ambiguous characters', () => {
    const password = newPassword();

    assert.equal(password.length, 12);
    assert.match(password, /^[A-HJKMNP-Za-hjkmnp-z2-9]+$/u);
    assert.equal(/[0Ol1I]/.test(password), false);
  });

  it('hashes the exact password as SHA-256 hex', () => {
    assert.equal(
      hashOf('hello'),
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('does not put a gated body into the page as readable markup', () => {
    const page = buildDocument('SECRET_ARTIFACT_BODY', 'dark', 'standalone', {
      title: 'Private report',
      gateHash: hashOf('correct password'),
    });

    assert.equal(page.includes('SECRET_ARTIFACT_BODY'), false);
    assert.match(page, /crypto\.subtle\.digest/);
    assert.match(page, /That password did not match/);
    assert.match(page, /<title>Private report<\/title>/);
  });

  it('leaves an ungated body readable and carries the standalone wrapper', () => {
    const page = buildDocument(BODY, 'light', 'standalone', { title: 'Public report' });

    assert.ok(page.includes(BODY));
    assert.match(page, /<title>Public report<\/title>/);
    assert.match(page, /--canvas: #f1f2f3/);
    assert.match(page, /--canvas: #1c1d1f/);
    assert.match(page, /\.chart\[data-chart\]/);
    assert.match(page, /createElementNS/);
    assert.match(page, /Content-Security-Policy/);
  });

  it('keeps the chart runtime in a gated page without exposing the body', () => {
    const page = buildDocument(BODY, 'dark', 'standalone', {
      title: 'Chart report',
      gateHash: hashOf('open sesame'),
    });

    assert.equal(page.includes(BODY), false);
    assert.match(page, /--canvas: #f1f2f3/);
    assert.match(page, /--canvas: #1c1d1f/);
    assert.match(page, /createElementNS/);
  });
});
