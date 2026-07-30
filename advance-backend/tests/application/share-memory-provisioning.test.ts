import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_PUBLISHING_REGISTERED_TOOL,
  provisionShareMemoryForExistingCompanies,
} from '../../src/application/skills/share-memory-provisioning.ts';
import { LarkMemoryReviewService } from '../../src/application/memory/lark-memory-review.service.ts';
import { buildArgsSummary } from '../../src/application/orchestration/tools/ai-sdk-adapter.ts';
import { asCompanyId, asUserId } from '../../src/shared/ids.ts';
import { asCompanyRoleSlug } from '../../src/domain/permissions/company-role.ts';

describe('Share Memory provisioning', () => {
  it('creates the registered capability and missing system skill without modifying existing rows', async () => {
    const createdTools: unknown[] = [];
    const createdSkills: unknown[] = [];
    const createdGrants: unknown[] = [];
    const db = {
      registeredTool: {
        findUnique: async () => null,
        create: async ({ data }: { data: unknown }) => {
          createdTools.push(data);
          return { id: 'memory-publishing' };
        },
      },
      company: { findMany: async () => [{ id: 'company-1' }, { id: 'company-2' }] },
      skill: {
        findFirst: async ({ where }: { where: { companyId: string } }) =>
          where.companyId === 'company-2' ? { id: 'existing-skill', isSystem: false } : null,
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          createdSkills.push(create);
          // recordSkillRegistryMutation snapshots the returned row.
          return { id: 'new-skill', revision: 1, createdBy: null, updatedBy: null, ...create };
        },
      },
      skillVersion: { upsert: async () => ({}) },
      skillRegistryRevision: { upsert: async () => ({}) },
      skillAccessGrant: {
        upsert: async ({ create }: { create: unknown }) => {
          createdGrants.push(create);
          return {};
        },
      },
    } as any;

    const result = await provisionShareMemoryForExistingCompanies(db);

    assert.deepEqual(result, {
      registeredToolCreated: true,
      skillsCreated: 1,
      skillsUpdated: 0,
      skillsExisting: 1,
    });
    assert.deepEqual(createdTools, [{
      ...MEMORY_PUBLISHING_REGISTERED_TOOL,
      guardrails: [...MEMORY_PUBLISHING_REGISTERED_TOOL.guardrails],
      engines: [],
      deprecated: false,
    }]);
    assert.equal((createdSkills[0] as { companyId: string }).companyId, 'company-1');
    assert.deepEqual(createdGrants, [{
      companyId: 'company-1',
      skillId: (createdSkills[0] as { id: string }).id,
      granteeType: 'company',
      granteeId: 'company-1',
    }]);
  });
});

describe('Lark Share Memory review', () => {
  it('publishes only the requester-reviewed facts and backend-returned target after a live RBAC recheck', async () => {
    const fixture = createMemoryReviewFixture();
    const tool = fixture.service.createMemoryReviewTool({
      runContext: fixture.runContext,
      perm: fixture.permission,
      chatId: 'chat-1',
      isSkillResolved: () => true,
    }) as { execute: (input: unknown) => Promise<string> };

    const result = await tool.execute({
      proposalId: 'proposal-1',
      bullets: ['Prefers concise weekly updates.', 'Project Atlas uses Lark.'],
    });
    assert.match(result, /waiting in a Lark review card/i);
    const reviewCard = parseCard(fixture.sentCards[0]);
    assert.match(JSON.stringify(reviewCard), /Prefers concise weekly updates/);

    const targetButton = findCardButtons(reviewCard).find(button => button.text.content === 'Save to Finance');
    assert.ok(targetButton);
    const value = JSON.parse(targetButton.value);
    const handled = await fixture.service.handle({
      action: { value: targetButton.value },
    }, fixture.actor);

    assert.equal(handled.ok, true);
    assert.equal(fixture.permissionResolutions, 1);
    assert.deepEqual(fixture.publishArgs, {
      operation: 'publish',
      scope: 'department',
      departmentId: 'dept-1',
      facts: ['Prefers concise weekly updates.', 'Project Atlas uses Lark.'],
    });
    assert.equal(fixture.publishRunContext?.tenantId, 'tenant-1');
    assert.equal(value.targetKey, 'department:dept-1');
    assert.match(JSON.stringify(parseCard(fixture.updatedCards[0])), /Saved 2 reviewed facts/);
  });

  it('rejects another group member and cancellation saves nothing', async () => {
    const fixture = createMemoryReviewFixture();
    const tool = fixture.service.createMemoryReviewTool({
      runContext: fixture.runContext,
      perm: fixture.permission,
      chatId: 'chat-1',
      isSkillResolved: () => true,
    }) as { execute: (input: unknown) => Promise<string> };
    await tool.execute({ proposalId: 'proposal-2', bullets: ['Uses dark mode.'] });
    const reviewCard = parseCard(fixture.sentCards[0]);
    const buttons = findCardButtons(reviewCard);
    const saveButton = buttons.find(button => button.text.content === 'Save to Personal');
    const cancelButton = buttons.find(button => button.text.content === 'Cancel');
    assert.ok(saveButton);
    assert.ok(cancelButton);

    const denied = await fixture.service.handle(
      { action: { value: saveButton.value } },
      { ...fixture.actor, userId: 'user-2', openId: 'open-2' },
    );
    assert.equal(denied.ok, false);
    assert.match(JSON.stringify(denied.responseBody), /Only the person who opened/i);

    const cancelled = await fixture.service.handle(
      { action: { value: cancelButton.value } },
      fixture.actor,
    );
    assert.equal(cancelled.ok, true);
    assert.equal(fixture.publishArgs, undefined);
    assert.match(JSON.stringify(parseCard(fixture.updatedCards[0])), /No memory was saved/);
  });

  it('claims a review before a slow publish so concurrent clicks cannot publish twice', async () => {
    let releasePublish!: () => void;
    const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
    const fixture = createMemoryReviewFixture({ publishGate });
    const tool = fixture.service.createMemoryReviewTool({
      runContext: fixture.runContext,
      perm: fixture.permission,
      chatId: 'chat-1',
      isSkillResolved: () => true,
    }) as { execute: (input: unknown) => Promise<string> };
    await tool.execute({ proposalId: 'proposal-3', bullets: ['Uses dark mode.'] });
    const saveButton = findCardButtons(parseCard(fixture.sentCards[0]))
      .find(button => button.text.content === 'Save to Personal');
    assert.ok(saveButton);

    const first = fixture.service.handle(
      { action: { value: saveButton.value } },
      fixture.actor,
    );
    await waitFor(() => fixture.publishCalls === 1);
    const second = await fixture.service.handle(
      { action: { value: saveButton.value } },
      fixture.actor,
    );
    releasePublish();
    const completed = await first;

    assert.equal(completed.ok, true);
    assert.equal(second.ok, false);
    assert.equal(fixture.publishCalls, 1);
  });

  it('closes a delivered card when its actionable state cannot be persisted', async () => {
    const fixture = createMemoryReviewFixture({ failCardStatePersist: true });
    const tool = fixture.service.createMemoryReviewTool({
      runContext: fixture.runContext,
      perm: fixture.permission,
      chatId: 'chat-1',
      isSkillResolved: () => true,
    }) as { execute: (input: unknown) => Promise<string> };

    const result = await tool.execute({ proposalId: 'proposal-4', bullets: ['Uses dark mode.'] });
    assert.match(result, /could not be opened safely/i);
    assert.match(JSON.stringify(parseCard(fixture.updatedCards[0])), /Memory was not saved/);
    const saveButton = findCardButtons(parseCard(fixture.sentCards[0]))
      .find(button => button.text.content === 'Save to Personal');
    assert.ok(saveButton);
    const replay = await fixture.service.handle(
      { action: { value: saveButton.value } },
      fixture.actor,
    );
    assert.equal(replay.ok, false);
    assert.equal(fixture.publishCalls, 0);
  });

  it('fails closed when card-state persistence and every cleanup attempt fail', async () => {
    const fixture = createMemoryReviewFixture({
      failCardStatePersist: true,
      failCompensation: true,
      failCardUpdate: true,
    });
    const tool = fixture.service.createMemoryReviewTool({
      runContext: fixture.runContext,
      perm: fixture.permission,
      chatId: 'chat-1',
      isSkillResolved: () => true,
    }) as { execute: (input: unknown) => Promise<string> };

    const result = await tool.execute({ proposalId: 'proposal-5', bullets: ['Uses dark mode.'] });
    assert.match(result, /could not be opened safely/i);
    const saveButton = findCardButtons(parseCard(fixture.sentCards[0]))
      .find(button => button.text.content === 'Save to Personal');
    assert.ok(saveButton);
    const replay = await fixture.service.handle(
      { action: { value: saveButton.value } },
      fixture.actor,
    );
    assert.equal(replay.ok, false);
    assert.match(JSON.stringify(replay.responseBody), /not opened safely/i);
    assert.equal(fixture.publishCalls, 0);
  });

  it('shows exact memory facts and target in a manager approval summary', () => {
    const summary = buildArgsSummary('memoryPublishing', 'create', {
      operation: 'publish',
      scope: 'company',
      facts: ['Uses dark mode.', 'Weekly finance review is Monday.'],
    });
    assert.equal(
      summary,
      'memoryPublishing.create | target=company\n1. Uses dark mode.\n2. Weekly finance review is Monday.',
    );
  });
});

function createMemoryReviewFixture(options: {
  publishGate?: Promise<void>;
  failCardStatePersist?: boolean;
  failCompensation?: boolean;
  failCardUpdate?: boolean;
} = {}) {
  const values = new Map<string, unknown>();
  const sentCards: string[] = [];
  const updatedCards: string[] = [];
  let publishArgs: Record<string, unknown> | undefined;
  let publishRunContext: Record<string, unknown> | undefined;
  let publishCalls = 0;
  let permissionResolutions = 0;
  let setCalls = 0;
  const permission = {
    allowedToolIds: new Set(['memoryPublishing']),
    allowedActionsByTool: new Map([['memoryPublishing', new Set(['read', 'create'])]]),
    decisions: [],
    department: {
      id: 'dept-1',
      name: 'Finance',
      roleSlug: 'manager',
      zohoReadScope: 'personalized',
    },
  } as any;
  const cache = {
    get: async <T>(key: string) => ({ ok: true as const, value: (values.get(key) ?? null) as T | null }),
    set: async <T>(key: string, value: T) => {
      setCalls += 1;
      if (options.failCardStatePersist && setCalls === 2) {
        return { ok: false as const, error: new Error('cache unavailable') };
      }
      values.set(key, value);
      return { ok: true as const, value: undefined };
    },
    setNx: async (key: string, value: unknown) => {
      if (options.failCompensation) {
        return { ok: false as const, error: new Error('cache unavailable') };
      }
      if (values.has(key)) return { ok: true as const, value: false };
      values.set(key, value);
      return { ok: true as const, value: true };
    },
    del: async (key: string) => {
      if (options.failCompensation) {
        return { ok: false as const, error: new Error('cache unavailable') };
      }
      values.delete(key);
      return { ok: true as const, value: undefined };
    },
    scanDel: async () => ({ ok: true as const, value: 0 }),
  };
  const adapter = {
    sendCardToChat: async (_chatId: string, card: string) => {
      sentCards.push(card);
      return { ok: true as const, value: { messageId: 'card-1' } };
    },
    updateMessageById: async (_messageId: string, card: string) => {
      if (options.failCardUpdate) {
        return { ok: false as const, error: new Error('Lark unavailable') };
      }
      updatedCards.push(card);
      return { ok: true as const, value: undefined };
    },
  };
  const toolExecutor = {
    executeForRuntime: async (input: {
      args: Record<string, unknown>;
      runContext?: Record<string, unknown>;
    }) => {
      if (input.args['operation'] === 'check_authority') {
        return {
          status: 'success',
          toolId: 'memoryPublishing',
          result: {
            operation: 'check_authority',
            availability: 'available',
            targets: [
              { scope: 'personal', label: 'Personal' },
              { scope: 'department', label: 'Finance', departmentId: 'dept-1' },
            ],
            scopeOutcomes: [],
          },
        };
      }
      publishCalls += 1;
      publishArgs = input.args;
      publishRunContext = input.runContext;
      if (options.publishGate) await options.publishGate;
      return {
        status: 'success',
        toolId: 'memoryPublishing',
        result: { operation: 'publish', scope: input.args['scope'], factCount: 2 },
      };
    },
  };
  const permissions = {
    resolve: async () => {
      permissionResolutions += 1;
      return { ok: true as const, value: permission };
    },
  };
  const logger = {
    child: () => logger,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
  const service = new LarkMemoryReviewService(
    cache as any,
    adapter as any,
    toolExecutor as any,
    permissions as any,
    {} as any,
    logger as any,
  );
  const runContext = {
    companyId: asCompanyId('company-1'),
    userId: asUserId('user-1'),
    companyRole: asCompanyRoleSlug('MEMBER'),
    departmentId: 'dept-1',
    channel: 'lark',
    userExternalId: 'open-1',
    chatId: 'chat-1',
  } as any;
  const actor = {
    userId: 'user-1',
    companyId: 'company-1',
    aiRole: 'MEMBER',
    openId: 'open-1',
    tenantKey: 'tenant-1',
    activeDepartmentId: 'dept-1',
  };
  return {
    service,
    permission,
    runContext,
    actor,
    sentCards,
    updatedCards,
    get publishArgs() { return publishArgs; },
    get publishRunContext() { return publishRunContext; },
    get publishCalls() { return publishCalls; },
    get permissionResolutions() { return permissionResolutions; },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for test condition.');
}

function parseCard(raw: string): Record<string, any> {
  const envelope = JSON.parse(raw);
  return JSON.parse(envelope.card);
}

function findCardButtons(card: Record<string, any>): Array<{
  text: { content: string };
  value: string;
}> {
  return card.elements
    .filter((element: Record<string, unknown>) => element['tag'] === 'action')
    .flatMap((element: { actions: unknown[] }) => element.actions);
}
