import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSignInCard,
  buildSignInConnectedCard,
  signInFallbackText,
  SIGN_IN_LINK_TTL_MINUTES,
  SIGN_IN_WORKSPACE_NOT_CONNECTED,
  SIGN_IN_DIRECTORY_UNAVAILABLE,
  SIGN_IN_UNAVAILABLE,
  SIGN_IN_MISSING_EMAIL,
} from '../../../src/infrastructure/channels/lark/lark-signin.ts';

const URL = 'https://divo.example/api/lark/connect?state=abc';

describe('buildSignInCard', () => {
  const parsed = JSON.parse(buildSignInCard({ name: 'Alice', url: URL }));
  const card = JSON.parse(parsed.card);
  const elements = card.body.elements as Array<Record<string, any>>;

  it('sends as an interactive card', () => {
    assert.equal(parsed.msg_type, 'interactive');
    assert.equal(card.schema, '2.0');
  });

  it('puts the link behind a button rather than in the text', () => {
    const button = elements.find(e => e.tag === 'button');
    assert.ok(button, 'the card has a button');
    assert.deepEqual(button?.['behaviors'], [{ type: 'open_url', default_url: URL }]);
  });

  it('greets the person by name', () => {
    assert.ok(elements.some(e => String(e['content'] ?? '').includes('Alice')));
  });

  it('states the expiry, so a stale card is self-explanatory', () => {
    const body = JSON.stringify(elements);
    assert.ok(body.includes(String(SIGN_IN_LINK_TTL_MINUTES)));
  });

  it('promises the original message will be answered', () => {
    assert.match(JSON.stringify(elements), /if nothing appears, send it again/i);
  });

  it('escapes nothing into the card structure itself', () => {
    // A name with quotes must not break the JSON envelope.
    const odd = JSON.parse(buildSignInCard({ name: 'A"B', url: URL }));
    assert.doesNotThrow(() => JSON.parse(odd.card));
  });
});

describe('buildSignInConnectedCard', () => {
  it('shows a green header with no sign-in button', () => {
    const parsed = JSON.parse(buildSignInConnectedCard({ name: 'Alice', replaying: true }));
    const card = JSON.parse(parsed.card);
    const elements = card.body.elements as Array<Record<string, unknown>>;

    assert.equal(card.header.template, 'green');
    assert.equal(elements.some(e => e['tag'] === 'button'), false);
    assert.match(JSON.stringify(elements), /Alice/);
    assert.match(JSON.stringify(elements), /earlier message/i);
  });

  it('uses idle copy when nothing is being replayed', () => {
    const parsed = JSON.parse(buildSignInConnectedCard({ name: 'Alice' }));
    const card = JSON.parse(parsed.card);
    assert.match(JSON.stringify(card.body.elements), /return to Lark/i);
  });
});

describe('signInFallbackText', () => {
  const text = signInFallbackText({ name: 'Alice', url: URL });

  it('carries the raw link, because it exists for when the card failed', () => {
    assert.ok(text.includes(URL));
  });

  it('makes the same promise as the card', () => {
    assert.match(text, /if nothing appears, send it again/i);
  });
});

describe('terminal first-touch notices', () => {
  it('tells an unconnected workspace what to do about it', () => {
    // This is the state every new customer starts in, and the one that used to
    // produce silence indistinguishable from Divo being down.
    assert.match(SIGN_IN_WORKSPACE_NOT_CONNECTED, /workspace/i);
    assert.match(SIGN_IN_WORKSPACE_NOT_CONNECTED, /admin|set Divo up/i);
  });

  it('owns a directory failure as ours rather than blaming the user', () => {
    assert.match(SIGN_IN_DIRECTORY_UNAVAILABLE, /my side|not yours/i);
  });

  it('blames itself when the sign-in link cannot be made', () => {
    assert.notEqual(SIGN_IN_UNAVAILABLE, SIGN_IN_WORKSPACE_NOT_CONNECTED);
    // Sign-in no longer depends on Lark OAuth, so this must not send anyone
    // off to check credentials that have nothing to do with it.
    assert.doesNotMatch(SIGN_IN_UNAVAILABLE, /configur|admin/i);
    assert.match(SIGN_IN_UNAVAILABLE, /my side|again/i);
  });

  it('says what is missing when a profile has no email', () => {
    assert.match(SIGN_IN_MISSING_EMAIL, /email/i);
  });

  it('never leaves a branch with an empty message', () => {
    for (const notice of [
      SIGN_IN_WORKSPACE_NOT_CONNECTED,
      SIGN_IN_DIRECTORY_UNAVAILABLE,
      SIGN_IN_UNAVAILABLE,
      SIGN_IN_MISSING_EMAIL,
    ]) {
      assert.ok(notice.trim().length > 40, 'a notice that says nothing is still silence');
    }
  });
});
