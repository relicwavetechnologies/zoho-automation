import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SemrushService } from '../../src/application/semrush/semrush.service.ts';
import { SemrushServiceError } from '../../src/application/semrush/semrush.types.ts';
import { createSemrushKeyProvider } from '../../src/application/semrush/semrush-key.provider.ts';

const logger = { info: () => undefined, warn: () => undefined } as any;
const overview = { operation: 'domain_overview' as const, domain: 'example.com' };
const complete = {
  operation: 'domain_overview',
  status: 'complete',
  coverage: { apiVersion: 'web_dpa' },
  rows: [{ Domain: 'example.com' }],
};

/** A provider with a fixed pool, so a test can say what "rotating" means. */
function poolProvider(keys: readonly string[]) {
  let index = 0;
  const resolved: string[] = [];
  return {
    resolved,
    canRotate: true,
    async resolve() {
      const key = keys[Math.min(index, keys.length - 1)]!;
      resolved.push(key);
      return key;
    },
    invalidate() { index += 1; },
  };
}

const staticProvider = (key = 'env-key') => ({
  canRotate: false,
  resolve: async () => key,
  invalidate: () => undefined,
});

describe('SemrushService', () => {
  it('passes the resolved key to the client and reports what came back', async () => {
    const calls: unknown[] = [];
    const service = new SemrushService(
      { fetch: async (input: any) => { calls.push(input); return complete; } } as any,
      staticProvider(),
      logger,
    );

    const result = await service.execute(overview);

    assert.equal(result.status, 'complete');
    assert.deepEqual(calls, [{ apiKey: 'env-key', args: overview }]);
  });

  it('surfaces a missing key rather than pretending Semrush answered', async () => {
    const service = new SemrushService(
      { fetch: async () => { throw new Error('must not call'); } } as any,
      createSemrushKeyProvider({ timeoutMs: 1_000 }),
      logger,
    );

    await assert.rejects(
      () => service.execute(overview),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'not_configured',
    );
  });

  for (const code of ['provider_auth_failed', 'provider_quota_exhausted'] as const) {
    it(`rotates to a fresh key when Semrush reports ${code}`, async () => {
      const provider = poolProvider(['spent-key', 'fresh-key']);
      const seen: string[] = [];
      const service = new SemrushService(
        {
          fetch: async ({ apiKey }: any) => {
            seen.push(apiKey);
            if (apiKey === 'spent-key') throw new SemrushServiceError(code, 'spent');
            return complete;
          },
        } as any,
        provider,
        logger,
      );

      const result = await service.execute(overview);

      assert.equal(result.status, 'complete');
      // The retry re-enters the client, which is what rebuilds the payload and
      // gives the second attempt a fresh params.request_id.
      assert.deepEqual(seen, ['spent-key', 'fresh-key']);
    });
  }

  it('does not rotate for throttling, which the same key recovers from', async () => {
    const provider = poolProvider(['only-key', 'never-used']);
    const service = new SemrushService(
      { fetch: async () => { throw new SemrushServiceError('rate_limited', 'busy'); } } as any,
      provider,
      logger,
    );

    await assert.rejects(
      () => service.execute(overview),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'rate_limited',
    );
    assert.equal(provider.resolved.length, 1, 'a throttle must not burn a key from the pool');
  });

  it('gives up instead of looping when the source has nothing newer', async () => {
    const provider = poolProvider(['only-key']);
    let attempts = 0;
    const service = new SemrushService(
      {
        fetch: async () => {
          attempts += 1;
          throw new SemrushServiceError('provider_auth_failed', 'refused');
        },
      } as any,
      provider,
      logger,
    );

    await assert.rejects(
      () => service.execute(overview),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'provider_auth_failed',
    );
    assert.equal(attempts, 1, 'the same dead key must not be spent twice');
  });

  it('never rotates when no rotation source is configured', async () => {
    let attempts = 0;
    const service = new SemrushService(
      {
        fetch: async () => {
          attempts += 1;
          throw new SemrushServiceError('provider_auth_failed', 'refused');
        },
      } as any,
      staticProvider(),
      logger,
    );

    await assert.rejects(() => service.execute(overview));
    assert.equal(attempts, 1);
  });
});

describe('createSemrushKeyProvider', () => {
  const webhookReturning = (body: unknown, status = 200) =>
    createSemrushKeyProvider({
      webhookUrl: 'https://example.invalid/key',
      timeoutMs: 1_000,
      fetchImpl: async () => new Response(JSON.stringify(body), { status }),
    });

  it('prefers the webhook, because a hardcoded key goes stale silently', async () => {
    const provider = createSemrushKeyProvider({
      environmentApiKey: 'stale-env-key',
      webhookUrl: 'https://example.invalid/key',
      timeoutMs: 1_000,
      fetchImpl: async () => new Response(JSON.stringify({ api_key: 'live-key', status: 'active' }), { status: 200 }),
    });
    assert.equal(await provider.resolve(), 'live-key');
    assert.equal(provider.canRotate, true);
  });

  it('caches until the key is reported spent, then looks again', async () => {
    let calls = 0;
    const provider = createSemrushKeyProvider({
      webhookUrl: 'https://example.invalid/key',
      timeoutMs: 1_000,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ api_key: `key-${calls}`, status: 'active' }), { status: 200 });
      },
    });

    assert.equal(await provider.resolve(), 'key-1');
    assert.equal(await provider.resolve(), 'key-1', 'a healthy key must not re-hit the webhook');
    provider.invalidate('key-1');
    assert.equal(await provider.resolve(), 'key-2');
    assert.equal(calls, 2);
  });

  it('falls back to the environment key rather than taking Semrush down with the webhook', async () => {
    const provider = createSemrushKeyProvider({
      environmentApiKey: 'env-key',
      webhookUrl: 'https://example.invalid/key',
      timeoutMs: 1_000,
      fetchImpl: async () => new Response('nope', { status: 500 }),
    });
    assert.equal(await provider.resolve(), 'env-key');
  });

  it('rejects a webhook key that is not marked active', async () => {
    await assert.rejects(
      () => webhookReturning({ api_key: 'some-key', status: 'exhausted' }).resolve(),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'not_configured',
    );
  });

  it('reads the live webhook shape, including a single-element array', async () => {
    // The n8n webhook answers {api_key, status, message}; some n8n nodes wrap
    // that in an array, and both shapes must resolve to the same key.
    assert.equal(await webhookReturning({ api_key: 'k', status: 'active', message: 'ok' }).resolve(), 'k');
    assert.equal(await webhookReturning([{ api_key: 'k', status: 'active' }]).resolve(), 'k');
  });

  it('cannot rotate when only an environment key exists', async () => {
    const provider = createSemrushKeyProvider({ environmentApiKey: 'env-key', timeoutMs: 1_000 });
    assert.equal(provider.canRotate, false);
    assert.equal(await provider.resolve(), 'env-key');
  });
});
