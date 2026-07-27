import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAitableKeyVerifier,
  reachesNoWorkspace,
} from '../../src/application/aitable/aitable-connect.service.ts';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const verifier = (impl: typeof fetch) =>
  createAitableKeyVerifier({ baseUrl: 'https://aitable.example', fetchImpl: impl });

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () => json(body, status)) as unknown as typeof fetch;

const ok = respond({ success: true, data: { spaces: [{ id: 'spc1', name: 'Growth' }] } });

describe('AITable key verification', () => {
  it('accepts a working key and reports the workspaces it reaches', async () => {
    const result = await verifier(ok).verify('usk_good');

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.spaces, [{ id: 'spc1', name: 'Growth' }]);
  });

  it('trims the pasted key before using it', async () => {
    let seenAuth: string | null = null;
    const impl = (async (_url: string | URL, init?: RequestInit) => {
      seenAuth = new Headers(init?.headers).get('authorization');
      return json({ success: true, data: { spaces: [] } });
    }) as unknown as typeof fetch;

    await verifier(impl).verify('  usk_padded\n');

    assert.equal(seenAuth, 'Bearer usk_padded');
  });

  // The distinction that matters most here. "AITable said no" means rotate the
  // key; "we could not ask AITable" means try again. Collapsing them into one
  // "invalid key" sends people rotating a good key during an outage.
  it('tells a rejected key apart from an unreachable AITable', async () => {
    const rejected = await verifier(respond({ message: 'unauthorized' }, 401)).verify('usk_dead');
    assert.equal(rejected.ok, false);
    assert.equal(!rejected.ok && rejected.reason, 'rejected');

    const down = await verifier(respond({ message: 'boom' }, 500)).verify('usk_fine');
    assert.equal(down.ok, false);
    assert.equal(!down.ok && down.reason, 'unreachable');

    const refused = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const offline = await verifier(refused).verify('usk_fine');
    assert.equal(!offline.ok && offline.reason, 'unreachable');
  });

  it('says a rate-limited check is not a verdict on the key', async () => {
    const limited = await verifier(respond({ message: 'slow down' }, 429)).verify('usk_fine');

    assert.equal(!limited.ok && limited.reason, 'unreachable');
    assert.match(!limited.ok ? limited.message : '', /not saved/i);
  });

  it('rejects an empty or blank key without calling AITable', async () => {
    let called = false;
    const impl = (async () => { called = true; return json({}); }) as unknown as typeof fetch;

    for (const blank of ['', '   ', '\n']) {
      const result = await verifier(impl).verify(blank);
      assert.equal(!result.ok && result.reason, 'empty', JSON.stringify(blank));
    }
    assert.equal(called, false, 'a blank key must not reach AITable');
  });

  // A key with no workspace is valid — its owner just has not been added to
  // one. It is accepted, and worth warning about, but it is not a rejection.
  it('accepts a valid key that reaches no workspace, and flags it', async () => {
    const result = await verifier(respond({ success: true, data: { spaces: [] } })).verify('usk_lonely');

    assert.equal(result.ok, true);
    assert.equal(reachesNoWorkspace(result), true);
  });

  it('does not flag a key that does reach a workspace', async () => {
    assert.equal(reachesNoWorkspace(await verifier(ok).verify('usk_good')), false);
  });

  it('never echoes the pasted key back in a failure message', async () => {
    const result = await verifier(respond({ message: 'unauthorized' }, 401)).verify('usk_super_secret');

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.message.includes('usk_super_secret'), false);
  });
});
