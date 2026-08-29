import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createBackendModelResolver,
  BackendModelUnavailable,
} from '../../src/application/proxy/backend-model.factory.ts';

/**
 * Which credential a background job spends, and on whose model.
 *
 * Every one of these pins a way the previous arrangement failed silently: the
 * provider fixed at boot, the key read from the process, and one credential
 * shared by every company on the install.
 */

const baseUrls = {
  deepseek: 'https://api.deepseek.example',
  openai: 'https://api.openai.example',
  meta: 'https://api.meta.example',
} as const;

describe('the model a backend job runs on', () => {
  it('follows the model id to its provider, not a client fixed at boot', async () => {
    const asked: string[] = [];
    const resolve = createBackendModelResolver({
      keys: {
        async resolve(provider) { asked.push(provider); return { key: `k-${provider}` }; },
      },
      baseUrls,
    });

    await resolve({ modelId: 'muse-spark-1.2-contributor', companyId: 'co-1' });
    await resolve({ modelId: 'deepseek-v4-flash', companyId: 'co-1' });
    assert.deepEqual(asked, ['meta', 'deepseek']);
  });

  it('asks for the company own key, never a process-wide one', async () => {
    const seen: string[] = [];
    const resolve = createBackendModelResolver({
      keys: {
        async resolve(_provider, companyId) { seen.push(companyId); return { key: 'k' }; },
      },
      baseUrls,
    });

    await resolve({ modelId: 'muse-spark-1.2-contributor', companyId: 'co-1' });
    await resolve({ modelId: 'muse-spark-1.2-contributor', companyId: 'co-2' });
    assert.deepEqual(seen, ['co-1', 'co-2']);
  });

  it('rebuilds when the key changes, so a rotation lands without a restart', async () => {
    let key = 'first-key';
    let built = 0;
    const resolve = createBackendModelResolver({
      keys: { async resolve() { built += 1; return { key }; } },
      baseUrls,
    });

    const a = await resolve({ modelId: 'muse-spark-1.2-contributor', companyId: 'co-1' });
    const b = await resolve({ modelId: 'muse-spark-1.2-contributor', companyId: 'co-1' });
    assert.equal(a, b, 'the same key must reuse one client');

    key = 'rotated-key-value';
    const c = await resolve({ modelId: 'muse-spark-1.2-contributor', companyId: 'co-1' });
    assert.notEqual(a, c, 'a rotated key must not keep serving the old client');
    assert.equal(built, 3, 'the store is consulted every time, never cached past a rotation');
  });

  it('says which provider is unconfigured rather than failing vaguely', async () => {
    // The failure a company actually hits: a model whose provider has no key.
    // "Insufficient Balance" from somebody else's account is what this replaces.
    const resolve = createBackendModelResolver({
      keys: { async resolve() { return null; } },
      baseUrls,
    });

    await assert.rejects(
      () => resolve({ modelId: 'muse-spark-1.2-contributor', companyId: 'co-1' }),
      (error: unknown) => {
        assert.ok(error instanceof BackendModelUnavailable);
        assert.equal(error.provider, 'meta');
        assert.match(error.message, /Guardrails/);
        return true;
      },
    );
  });
});
