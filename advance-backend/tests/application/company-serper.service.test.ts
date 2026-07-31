import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CompanySerperService } from '../../src/application/web-search/company-serper.service.ts';
import { SearchIntegrationError } from '../../src/infrastructure/ai/search/serper.client.ts';
import { serperKeyFingerprint } from '../../src/infrastructure/persistence/company-serper-connection.repository.ts';
import type { Logger } from '../../src/shared/logger.ts';

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeService(connections: {
  activeKeys: (companyId: string) => Promise<Array<{ id: string; apiKey: string }>>;
  hasConnection: (companyId: string) => Promise<boolean>;
  markSuccess: (id: string) => Promise<void>;
  markFailure: (id: string, code: string, unavailableUntil: Date) => Promise<void>;
  markCreditsExhausted?: (id: string, code: string) => Promise<void>;
}) {
  return new CompanySerperService(
    connections as any,
    {} as any,
    1_000,
    noopLogger,
  );
}

describe('CompanySerperService.search', () => {
  it('cools down a rate-limited company key and uses the next healthy key', async () => {
    const successes: string[] = [];
    const failures: Array<{ id: string; code: string; unavailableUntil: Date }> = [];
    const startedAt = Date.now();
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const key = new Headers(init?.headers).get('X-API-KEY');
      if (key === 'first-key') {
        return {
          ok: false,
          status: 429,
          headers: new Headers({ 'retry-after': '15' }),
          text: async () => 'Too many requests',
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({ organic: [{ title: 'Result', link: 'https://example.com', snippet: 'Ok' }] }),
      } as Response;
    };

    const service = makeService({
      activeKeys: async () => [{ id: 'first', apiKey: 'first-key' }, { id: 'second', apiKey: 'second-key' }],
      hasConnection: async () => true,
      markSuccess: async id => { successes.push(id); },
      markFailure: async (id, code, unavailableUntil) => { failures.push({ id, code, unavailableUntil }); },
    });

    const result = await service.search('company-1', { query: 'Divo' });

    assert.equal(result.organic[0]?.title, 'Result');
    assert.deepEqual(successes, ['second']);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.id, 'first');
    assert.equal(failures[0]?.code, 'search_rate_limited');
    assert.ok((failures[0]?.unavailableUntil.getTime() ?? 0) >= startedAt + 14_900);
  });

  it('retires a credit-exhausted key and uses the next healthy key', async () => {
    const exhausted: Array<{ id: string; code: string }> = [];
    const receivedKeys: string[] = [];
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const key = new Headers(init?.headers).get('X-API-KEY') ?? '';
      receivedKeys.push(key);
      if (key === 'exhausted-key') {
        return {
          ok: false,
          status: 400,
          headers: new Headers(),
          text: async () => JSON.stringify({ message: 'Not enough credits', statusCode: 400 }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({ organic: [] }),
      } as Response;
    };

    const service = makeService({
      activeKeys: async () => [{ id: 'first', apiKey: 'exhausted-key' }, { id: 'second', apiKey: 'healthy-key' }],
      hasConnection: async () => true,
      markSuccess: async () => {},
      markFailure: async () => {},
      markCreditsExhausted: async (id, code) => { exhausted.push({ id, code }); },
    });

    await service.search('company-1', { query: 'Divo' });

    assert.deepEqual(receivedKeys, ['exhausted-key', 'healthy-key']);
    assert.deepEqual(exhausted, [{ id: 'first', code: 'search_credits_exhausted' }]);
  });

  it('uses the legacy environment key only when the company has no active connection', async () => {
    const receivedKeys: string[] = [];
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      receivedKeys.push(new Headers(init?.headers).get('X-API-KEY') ?? '');
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({ organic: [] }),
      } as Response;
    };
    const service = new CompanySerperService(
      {
        activeKeys: async () => [],
        hasConnection: async () => false,
        markSuccess: async () => {},
        markFailure: async () => {},
      } as any,
      {} as any,
      1_000,
      noopLogger,
      'legacy-key',
    );

    await service.search('company-1', { query: 'Divo' });
    assert.deepEqual(receivedKeys, ['legacy-key']);
  });

  it('does not bypass an unavailable company pool with the legacy environment key', async () => {
    let fetchCalled = false;
    globalThis.fetch = async (): Promise<Response> => {
      fetchCalled = true;
      throw new Error('should not be called');
    };
    const service = makeService({
      activeKeys: async () => [],
      hasConnection: async () => true,
      markSuccess: async () => {},
      markFailure: async () => {},
    });

    await assert.rejects(
      () => service.search('company-1', { query: 'Divo' }),
      (error: SearchIntegrationError) => error.code === 'search_unavailable',
    );
    assert.equal(fetchCalled, false);
  });

  it('notifies once when every company Serper key is rate-limited', async () => {
    const notices: Array<{ companyId: string; provider: string; force?: boolean }> = [];
    globalThis.fetch = async (): Promise<Response> => ({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '30' }),
      text: async () => 'Too many requests',
    } as Response);

    const service = makeService({
      activeKeys: async () => [{ id: 'a', apiKey: 'a-key' }, { id: 'b', apiKey: 'b-key' }],
      hasConnection: async () => true,
      markSuccess: async () => {},
      markFailure: async () => {},
    });
    service.bindExhaustionNotifier({
      notifyIfExhausted: async (input) => {
        notices.push({ companyId: input.companyId, provider: input.provider, force: input.force });
        return { notified: true };
      },
      clear: async () => {},
    });

    await assert.rejects(
      () => service.search('company-1', { query: 'Divo' }),
      (error: SearchIntegrationError) => error.code === 'search_rate_limited',
    );
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0], { companyId: 'company-1', provider: 'serper', force: true });
  });
});

describe('CompanySerperService.saveVerified', () => {
  it('persists the admin-entered balance with the verified connection', async () => {
    let saved: Record<string, unknown> | undefined;
    const service = new CompanySerperService(
      {
        saveVerified: async (input: Record<string, unknown>) => {
          saved = input;
          return {};
        },
      } as any,
      {
        get: async () => ({ ok: true, value: { companyId: 'company-1', userId: 'user-1', fingerprint: serperKeyFingerprint('key-1') } }),
        del: async () => ({ ok: true }),
      } as any,
      1_000,
      noopLogger,
    );

    await service.saveVerified({
      companyId: 'company-1', userId: 'user-1', label: 'Primary', apiKey: 'key-1',
      verificationToken: 'token', remainingCredits: 2_499,
    });

    assert.equal(saved?.remainingCredits, 2_499);
  });
});
