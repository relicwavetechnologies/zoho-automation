import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBeginGoogleAuthorization } from '../../src/application/connections/begin-google-authorization';
import { createWebConnectionAskCourier } from '../../src/application/connections/connection-request/web.courier';
import { RunOriginStore, type RunOrigin } from '../../src/application/connections/run-origin.store';
import type { CachePort } from '../../src/shared/cache';
import type { RunContext } from '../../src/domain/orchestration/run-context';
import { asCompanyId, asUserId } from '../../src/shared/ids';
import { asCompanyRoleSlug } from '../../src/domain/permissions/company-role';
import { ok } from '../../src/shared/result';

function cache(): CachePort {
  const entries = new Map<string, unknown>();
  return {
    async get<T>(key: string) { return ok((entries.get(key) ?? null) as T | null); },
    async set<T>(key: string, value: T) { entries.set(key, value); return ok(undefined); },
    async setNx() { return ok(true); },
    async del(key: string) { entries.delete(key); return ok(undefined); },
    async scanDel() { return ok(0); },
  };
}

function runContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    companyId: asCompanyId('company-1'),
    userId: asUserId('user-1'),
    companyRole: asCompanyRoleSlug('MEMBER'),
    channel: 'web',
    chatId: 'web-thread-1',
    runtimeRunId: 'web-run-1',
    ...overrides,
  };
}

const ORIGIN: RunOrigin = {
  version: 1,
  channel: 'web',
  companyId: 'company-1',
  userId: 'user-1',
  originalRequest: 'Export the Sheet',
  conversationKey: 'web-thread-1',
  web: {
    threadId: 'web-thread-1',
    userExternalId: 'user-1',
    sessionId: 'session-1',
    timestamp: '2026-08-21T00:00:00.000Z',
  },
};

describe('web Google connection ask', () => {
  it('creates one branded decision with an HTTPS link and does not settle it', async () => {
    let asked: any;
    const courier = createWebConnectionAskCourier({
      decisions: {
        ask: async input => {
          asked = input;
          return {
            ok: true,
            created: true,
            replacedExpired: false,
            deliveredVia: 'divo' as const,
            requestState: 'created' as const,
            decision: {} as any,
            row: {} as any,
          };
        },
      },
    });

    const result = await courier.deliver({
      gap: {
        provider: 'google_workspace',
        toolId: 'googleSheets',
        toolIds: ['googleSheets', 'googleDrive'],
        missingScopeGroups: [['sheets']],
        reason: 'insufficient_scope',
      },
      runContext: runContext(),
      intentId: 'intent-1',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/auth?state=opaque',
    });

    assert.deepEqual(result, { status: 'sent', intentId: 'intent-1' });
    assert.equal(asked.channel, 'web');
    assert.equal(asked.conversationKey, 'web-thread-1');
    assert.equal(asked.idempotencyKey, 'intent-1');
    assert.deepEqual(asked.continuation, { kind: 'none' });
    assert.deepEqual(asked.subject, {
      brand: 'google',
      action: 'Connect Google Workspace',
      target: 'Google access',
      preview: { kind: 'access', scopes: ['Google Sheets', 'Google Drive'] },
    });
    assert.equal(asked.questions[0].options[0].href.startsWith('https://'), true);
    assert.equal(asked.questions[0].options[0].settles, undefined);
  });

  it('reuses an open decision without issuing a second sent outcome', async () => {
    const courier = createWebConnectionAskCourier({
      decisions: {
        ask: async () => ({
          ok: true,
          created: false,
          replacedExpired: false,
          deliveredVia: 'divo' as const,
          requestState: 'reused' as const,
          decision: {} as any,
          row: {} as any,
        }),
      },
    });
    const result = await courier.deliver({
      gap: {
        provider: 'google_workspace',
        toolId: 'googleDrive',
        missingScopeGroups: [['drive']],
        reason: 'not_connected',
      },
      runContext: runContext(),
      intentId: 'intent-existing',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/auth?state=opaque',
    });
    assert.deepEqual(result, { status: 'already_pending', intentId: 'intent-existing' });
  });

  it('uses the existing Google intent row and web origin before asking', async () => {
    const origins = new RunOriginStore(cache());
    await origins.remember('web-run-1', ORIGIN);
    let target: any;
    let courierInput: any;
    const begin = createBeginGoogleAuthorization({
      runOrigins: origins,
      authorization: {
        issue: async input => {
          target = input;
          return {
            outcome: 'issued' as const,
            intentId: 'intent-web-1',
            authorizeUrl: 'https://accounts.google.com/o/oauth2/auth?state=opaque',
          };
        },
      } as any,
      webCourier: () => ({
        deliver: async input => {
          courierInput = input;
          return { status: 'sent' as const, intentId: input.intentId };
        },
      }),
      deliverConnectCard: () => undefined,
      logger: {
        child: () => undefined,
        info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
      } as any,
    });

    const result = await begin({
      gap: {
        provider: 'google_workspace',
        toolId: 'googleSheets',
        toolIds: ['googleSheets'],
        missingScopeGroups: [['sheets']],
        reason: 'insufficient_scope',
      },
      reason: 'The connected account is missing access.',
      runContext: runContext(),
    });

    assert.deepEqual(result, { status: 'sent', intentId: 'intent-web-1' });
    assert.equal(target.chatType, 'web');
    assert.equal(target.larkTenantKey, 'web');
    assert.equal(target.originalMessageId, 'web-run-1');
    assert.equal(target.chatId, 'web-thread-1');
    assert.equal(courierInput.gap.reason, 'insufficient_scope');
    assert.equal(courierInput.runContext.channel, 'web');
  });
});
