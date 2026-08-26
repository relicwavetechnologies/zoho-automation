import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

/**
 * The chat-id rule, pinned against ids taken from the real database.
 *
 * This exists because the first version of the rule was written from the
 * gateway spec's *examples* rather than from stored rows, accepted only `@c.us`
 * and `@g.us`, and refused every direct message Divo had ever tracked — all of
 * which are `@lid`. The send failed with `invalid_request` at the moment
 * somebody pressed the button.
 *
 * A copy of the regex rather than an import: the route builds it inline, and the
 * value of this test is that the *shape* is checked against real data. If the
 * two drift, the assertions below are the ones that should be trusted and the
 * route corrected to match.
 */
const waChatId = z.string().trim().regex(
  /^\d{5,20}(-\d{5,20})?@(c\.us|g\.us|lid|s\.whatsapp\.net)$/,
);

const accepts = (value: string) => waChatId.safeParse(value).success;

describe('waChatId', () => {
  /** Verbatim from `WhatsappChat` rows on the dev database, 26 Aug 2026. */
  it('accepts every id form actually stored', () => {
    for (const id of [
      '120363403766030990@g.us',   // group
      '120363323602743963@g.us',   // group
      '12592995127491@lid',        // direct — privacy-preserving id
      '125808668598352@lid',
      '14048921968834@lid',
      '105561739817145@lid',
      '189146182205640@lid',
    ]) {
      assert.ok(accepts(id), `should accept a real stored id: ${id}`);
    }
  });

  it('accepts the phone-derived forms the two engines use', () => {
    assert.ok(accepts('919876543210@c.us'));
    assert.ok(accepts('919876543210@s.whatsapp.net'));
  });

  /** Legacy group ids are `<creator>-<created-at>@g.us`. */
  it('accepts a legacy hyphenated group id', () => {
    assert.ok(accepts('919891111548-1612345678@g.us'));
  });

  it('still refuses things that are not chat ids', () => {
    for (const bad of [
      '',
      'not-an-id',
      '919876543210',              // no suffix
      '@c.us',                     // no id
      '919876543210@example.com',  // wrong suffix
      '919876543210@broadcast',    // status broadcast, never a send target
      'abc123@lid',                // not digits
      '1234@c.us',                 // too short to be anything real
    ]) {
      assert.ok(!accepts(bad), `should refuse: ${JSON.stringify(bad)}`);
    }
  });

  it('trims surrounding whitespace rather than refusing it', () => {
    assert.ok(accepts('  12592995127491@lid  '));
  });
});
