import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isApiKeyExhausted,
  isSerperPoolExhausted,
} from '../../src/application/governance/api-key-exhaustion.classifier.ts';
import { ApiKeyExhaustionNotifier } from '../../src/application/governance/api-key-exhaustion.notifier.ts';
import type { CachePort } from '../../src/shared/cache.ts';
import { ok } from '../../src/shared/result.ts';
import type { Logger } from '../../src/shared/logger.ts';

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

describe('isApiKeyExhausted', () => {
  it('recognizes known provider codes and billing statuses', () => {
    assert.equal(isApiKeyExhausted({ code: 'search_rate_limited' }), true);
    assert.equal(isApiKeyExhausted({ code: 'provider_insufficient_units' }), true);
    assert.equal(isApiKeyExhausted({ httpStatus: 402 }), true);
    assert.equal(isApiKeyExhausted({ message: 'insufficient_quota' }), true);
    assert.equal(isApiKeyExhausted({ code: 'search_credits_exhausted', message: 'Not enough credits' }), true);
    assert.equal(isApiKeyExhausted({ httpStatus: 429, message: 'quota exceeded' }), true);
  });

  it('does not treat bare RPM 429 or unrelated errors as key exhaustion', () => {
    assert.equal(isApiKeyExhausted({ httpStatus: 429, message: 'Too many requests' }), false);
    assert.equal(isApiKeyExhausted({ httpStatus: 500, message: 'server error' }), false);
    assert.equal(isApiKeyExhausted({ message: 'Monthly budget of $10 reached.' }), false);
  });

  it('marks Serper pool failures as exhausted', () => {
    assert.equal(isSerperPoolExhausted({ code: 'search_rate_limited' }), true);
    assert.equal(isSerperPoolExhausted({ code: 'search_credits_exhausted' }), true);
    assert.equal(isSerperPoolExhausted({ code: 'search_unavailable' }), true);
    assert.equal(isSerperPoolExhausted({ code: 'search_invalid_response' }), false);
  });
});

describe('ApiKeyExhaustionNotifier', () => {
  it('sends once per company+provider and skips thereafter', async () => {
    const keys = new Map<string, unknown>();
    const cache: CachePort = {
      get: async () => ok(null),
      set: async () => ok(undefined),
      setNx: async (key, value) => {
        if (keys.has(key)) return ok(false);
        keys.set(key, value);
        return ok(true);
      },
      del: async (key) => { keys.delete(key); return ok(undefined); },
      scanDel: async () => ok(0),
    };
    const cards: string[] = [];
    const notifier = new ApiKeyExhaustionNotifier({
      cache,
      approvalResolver: {
        resolveCompanyAdmin: async () => ({
          userId: 'admin-1',
          larkOpenId: 'ou_admin',
          displayName: 'Admin',
        }),
      } as any,
      larkAdapter: {
        sendDirectCard: async (_openId, card) => {
          cards.push(card);
          return ok({ messageId: `msg-${cards.length}` });
        },
      },
      logger: noopLogger,
    });

    const first = await notifier.notifyIfExhausted({
      companyId: 'co-1',
      provider: 'serper',
      code: 'search_rate_limited',
      message: 'All Serper keys rate limited',
      force: true,
    });
    const second = await notifier.notifyIfExhausted({
      companyId: 'co-1',
      provider: 'serper',
      code: 'search_rate_limited',
      message: 'All Serper keys rate limited',
      force: true,
    });

    assert.equal(first.notified, true);
    assert.equal(second.notified, false);
    assert.equal(cards.length, 1);
    assert.match(cards[0]!, /Web search \(Serper\)/);
  });

  it('does not throw when no company admin has Lark', async () => {
    const cache: CachePort = {
      get: async () => ok(null),
      set: async () => ok(undefined),
      setNx: async () => ok(true),
      del: async () => ok(undefined),
      scanDel: async () => ok(0),
    };
    const notifier = new ApiKeyExhaustionNotifier({
      cache,
      approvalResolver: {
        resolveCompanyAdmin: async () => null,
      } as any,
      larkAdapter: {
        sendDirectCard: async () => {
          throw new Error('should not send');
        },
      },
      logger: noopLogger,
    });

    const result = await notifier.notifyIfExhausted({
      companyId: 'co-2',
      provider: 'deepseek',
      httpStatus: 402,
      message: 'Insufficient balance',
    });
    assert.equal(result.notified, false);
  });

  it('clear allows a later exhaustion to notify again', async () => {
    const keys = new Map<string, unknown>();
    const cache: CachePort = {
      get: async () => ok(null),
      set: async () => ok(undefined),
      setNx: async (key, value) => {
        if (keys.has(key)) return ok(false);
        keys.set(key, value);
        return ok(true);
      },
      del: async (key) => { keys.delete(key); return ok(undefined); },
      scanDel: async () => ok(0),
    };
    let sends = 0;
    const notifier = new ApiKeyExhaustionNotifier({
      cache,
      approvalResolver: {
        resolveCompanyAdmin: async () => ({
          userId: 'admin-1',
          larkOpenId: 'ou_admin',
          displayName: 'Admin',
        }),
      } as any,
      larkAdapter: {
        sendDirectCard: async () => {
          sends += 1;
          return ok({ messageId: `msg-${sends}` });
        },
      },
      logger: noopLogger,
    });

    await notifier.notifyIfExhausted({
      companyId: 'co-3',
      provider: 'deepseek',
      httpStatus: 402,
      message: 'billing hard limit',
    });
    await notifier.clear('co-3', 'deepseek');
    await notifier.notifyIfExhausted({
      companyId: 'co-3',
      provider: 'deepseek',
      httpStatus: 402,
      message: 'billing hard limit again',
    });
    assert.equal(sends, 2);
  });
});
