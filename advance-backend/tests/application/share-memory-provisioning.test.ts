import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_KNOWLEDGE_POLICIES,
  KNOWLEDGE_REGISTERED_TOOL,
  provisionKnowledgeForExistingCompanies,
} from '../../src/application/skills/knowledge-provisioning.ts';
import { LarkKnowledgeReviewService } from '../../src/application/knowledge/lark-knowledge-review.service.ts';
import { buildArgsSummary } from '../../src/application/gateway/args-summary.ts';
import { asCompanyId, asUserId } from '../../src/shared/ids.ts';
import { asCompanyRoleSlug } from '../../src/domain/permissions/company-role.ts';

describe('Share Memory provisioning', () => {
  it('creates the registered capability and missing system skill without modifying existing rows', async () => {
    const createdTools: unknown[] = [];
    const createdSkills: unknown[] = [];
    const createdGrants: unknown[] = [];
    const createdPolicies: unknown[] = [];
    const db: any = {
      $transaction: async (operation: (tx: any) => Promise<unknown>) => operation(db),
      skillCapability: { deleteMany: async () => ({ count: 0 }) },
      departmentUserToolOverride: { deleteMany: async () => ({ count: 0 }) },
      departmentToolPermission: { deleteMany: async () => ({ count: 0 }) },
      toolActionPermission: { deleteMany: async () => ({ count: 0 }) },
      toolPermission: { deleteMany: async () => ({ count: 0 }) },
      knowledgePolicy: {
        createMany: async ({ data }: { data: unknown[] }) => {
          createdPolicies.push(...data);
          return { count: data.length };
        },
        updateMany: async () => ({ count: 4 }),
      },
      registeredTool: {
        findUnique: async () => null,
        deleteMany: async () => ({ count: 3 }),
        create: async ({ data }: { data: unknown }) => {
          createdTools.push(data);
          return { id: 'memory-publishing' };
        },
      },
      company: { findMany: async () => [{ id: 'company-1' }, { id: 'company-2' }] },
      skill: {
        updateMany: async () => ({ count: 2 }),
        findMany: async () => [{ companyId: 'company-1' }, { companyId: 'company-2' }],
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
    };

    const result = await provisionKnowledgeForExistingCompanies(db);

    assert.deepEqual(result, {
      registeredToolCreated: true,
      policiesCreated: 36,
      policiesUpdated: 4,
      legacySkillsArchived: 2,
      retiredToolsDeleted: 3,
      skillsCreated: 1,
      skillsUpdated: 0,
      skillsExisting: 1,
    });
    assert.deepEqual(createdPolicies, DEFAULT_KNOWLEDGE_POLICIES);
    assert.deepEqual(createdTools, [{
      ...KNOWLEDGE_REGISTERED_TOOL,
      guardrails: [...KNOWLEDGE_REGISTERED_TOOL.guardrails],
      engines: [],
      deprecated: false,
    }]);
    assert.equal((createdSkills[0] as { companyId: string }).companyId, 'company-1');
    const knowledgeInstructions = String((createdSkills[0] as { markdown?: unknown }).markdown);
    assert.match(knowledgeInstructions, /dedicated synchronous personal-memory command/i);
    assert.match(knowledgeInstructions, /report completion only from its verified result/i);
    assert.match(knowledgeInstructions, /implicit personal facts may be evaluated asynchronously/i);
    assert.deepEqual(createdGrants, [{
      companyId: 'company-1',
      skillId: (createdSkills[0] as { id: string }).id,
      granteeType: 'company',
      granteeId: 'company-1',
    }]);
  });
});

describe('Lark Share Memory review', () => {
  it('never offers Personal from the shared-memory review when scope is omitted', async () => {
    const fixture = createMemoryReviewFixture();
    const result = await openMemoryReview(
      fixture,
      'proposal-shared-only',
      ['Finance closes its weekly books every Friday.'],
    );

    assert.equal(result.opened, true);
    const buttons = findCardButtons(parseCard(fixture.sentCards[0]));
    assert.equal(buttons.some(button => button.text.content === 'Save to Personal'), false);
    assert.ok(buttons.some(button => button.text.content === 'Save to Department: Finance'));
    assert.ok(buttons.some(button => button.text.content === 'Save to Company'));
  });

  it('does not open a shared-memory card when Personal is the only authorized target', async () => {
    const fixture = createMemoryReviewFixture({
      knowledgeTargets: [{ scope: 'personal', label: 'Personal' }],
    });
    const result = await openMemoryReview(
      fixture,
      'proposal-personal-only',
      ['Prefers concise weekly updates.'],
    );

    assert.equal(result.opened, false);
    assert.match(result.message, /available shared memory target/i);
    assert.equal(fixture.sentCards.length, 0);
  });

  it('opens a department-only card for an explicit backend-routed department command', async () => {
    const fixture = createMemoryReviewFixture();
    const result = await openMemoryReview(
      fixture,
      'proposal-department-only',
      ['Finance closes its weekly books every Friday.'],
      'department',
    );

    assert.equal(result.opened, true);
    const buttons = findCardButtons(parseCard(fixture.sentCards[0]));
    assert.ok(buttons.some(button => button.text.content === 'Save to Department: Finance'));
    assert.equal(buttons.some(button => button.text.content === 'Save to Department: Operations'), false);
    assert.equal(buttons.some(button => button.text.content === 'Save to Company'), false);
  });

  it('reviews and submits an exact shared file through the legacy Lark file flow', async () => {
    const fixture = createMemoryReviewFixture();
    const content = {
      fileName: 'finance-runbook.md',
      mimeType: 'text/markdown',
      sizeBytes: 42,
      storageKey: 'company-1/finance-runbook.md',
    };
    const opened = await fixture.service.openResourceForRuntime({
      requestId: 'knowledge:file-1',
      kind: 'file',
      action: 'publish',
      scope: 'department',
      logicalKey: 'finance-runbook',
      content,
      runContext: fixture.runContext,
      perm: fixture.permission,
      chatId: 'chat-1',
    });
    assert.equal(opened.opened, true);
    const card = parseCard(fixture.sentCards[0]);
    assert.match(JSON.stringify(card), /finance-runbook\.md/);
    assert.doesNotMatch(JSON.stringify(card), /company-1\/finance-runbook\.md/);
    const button = findCardButtons(card)
      .find(candidate => candidate.text.content === 'Send to Department: Finance');
    assert.ok(button);
    const handled = await fixture.service.handle(
      { action: { value: button.value } },
      fixture.actor,
    );
    assert.equal(handled.ok, true);
    assert.deepEqual(fixture.publishArgs, {
      operation: 'apply',
      mutationId: 'mutation-1',
      contentHash: 'a'.repeat(64),
      kind: 'file',
      action: 'publish',
      scope: 'department',
      departmentId: 'dept-1',
      content,
    });
  });

  it('reviews a personal file and applies it without creating shared approval', async () => {
    const fixture = createMemoryReviewFixture();
    const content = {
      fileName: 'my-document-style.md',
      mimeType: 'text/markdown',
      sizeBytes: 38,
      storageKey: 'user-1/my-document-style.md',
    };
    const opened = await fixture.service.openResourceForRuntime({
      requestId: 'knowledge:personal-file-1',
      kind: 'file',
      action: 'publish',
      scope: 'personal',
      logicalKey: 'my-document-style',
      content,
      runContext: fixture.runContext,
      perm: fixture.permission,
      chatId: 'chat-1',
    });
    assert.equal(opened.opened, true);
    assert.match(opened.message, /exact file change/i);
    const button = findCardButtons(parseCard(fixture.sentCards[0]))
      .find(candidate => candidate.text.content === 'Save to Personal');
    assert.ok(button);

    const handled = await fixture.service.handle(
      { action: { value: button.value } },
      fixture.actor,
    );

    assert.equal(handled.ok, true);
    assert.deepEqual(fixture.publishArgs, {
      operation: 'apply',
      mutationId: 'mutation-1',
      contentHash: 'a'.repeat(64),
      kind: 'file',
      action: 'publish',
      scope: 'personal',
      content,
    });
  });

  it('publishes only the requester-reviewed facts and backend-returned target after a live RBAC recheck', async () => {
    const fixture = createMemoryReviewFixture();
    const result = await openMemoryReview(fixture, 'proposal-1', [
      'Prefers concise weekly updates.',
      'Project Atlas uses Lark.',
    ]);
    assert.match(result.message, /waiting in a Lark review card/i);
    const reviewCard = parseCard(fixture.sentCards[0]);
    assert.match(JSON.stringify(reviewCard), /Prefers concise weekly updates/);

    const targetButton = findCardButtons(reviewCard)
      .find(button => button.text.content === 'Save to Department: Finance');
    assert.ok(targetButton);
    const value = targetButton.value as Record<string, unknown>;
    const handled = await fixture.service.handle({
      action: { value: targetButton.value },
    }, fixture.actor);

    assert.equal(handled.ok, true);
    assert.equal(fixture.permissionResolutions, 1);
    assert.deepEqual(fixture.publishArgs, {
      operation: 'apply',
      mutationId: 'mutation-1',
      contentHash: 'a'.repeat(64),
      kind: 'memory',
      action: 'publish',
      scope: 'department',
      departmentId: 'dept-1',
      content: { facts: ['Prefers concise weekly updates.', 'Project Atlas uses Lark.'] },
    });
    assert.equal(fixture.publishRunContext?.tenantId, 'tenant-1');
    assert.equal(value.targetKey, 'department:dept-1');
    assert.match(JSON.stringify(parseCard(fixture.updatedCards[0])), /Saved 2 reviewed facts/);
  });

  it('rejects another group member and cancellation saves nothing', async () => {
    const fixture = createMemoryReviewFixture();
    await openMemoryReview(fixture, 'proposal-2', ['Uses dark mode.']);
    const reviewCard = parseCard(fixture.sentCards[0]);
    const buttons = findCardButtons(reviewCard);
    const saveButton = buttons.find(button => button.text.content === 'Save to Department: Finance');
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
    await openMemoryReview(fixture, 'proposal-3', ['Uses dark mode.']);
    const saveButton = findCardButtons(parseCard(fixture.sentCards[0]))
      .find(button => button.text.content === 'Save to Department: Finance');
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

  it('acknowledges a card decision immediately and processes it once through the durable queue', async () => {
    const fixture = createMemoryReviewFixture({ queued: true });
    await openMemoryReview(fixture, 'proposal-queued', ['Uses dark mode.']);
    const reviewCard = parseCard(fixture.sentCards[0]);
    const saveButton = findCardButtons(reviewCard)
      .find(button => button.text.content === 'Save to Department: Finance');
    assert.ok(saveButton);
    assert.deepEqual(saveButton.confirm, {
      title: { tag: 'plain_text', content: 'Confirm shared memory target' },
      text: {
        tag: 'plain_text',
        content: 'Send these exact facts for Finance department-manager approval?',
      },
    });
    const value = saveButton.value as Record<string, string>;

    const first = await fixture.service.handle(
      { action: { value: saveButton.value } },
      fixture.actor,
    );
    const duplicate = await fixture.service.handle(
      { action: { value: saveButton.value } },
      fixture.actor,
    );

    assert.deepEqual(first.responseBody, {
      toast: { type: 'info', content: 'Memory decision received. Divo is processing it.' },
    });
    assert.deepEqual(duplicate.responseBody, first.responseBody);
    assert.deepEqual(fixture.enqueuedReviewIds, [value.reviewId]);
    assert.equal(fixture.publishCalls, 0);

    await fixture.service.processQueuedDecision(value.reviewId);
    assert.equal(fixture.publishCalls, 1);
    assert.match(JSON.stringify(parseCard(fixture.updatedCards[0])), /Saved 1 reviewed fact/);

    await fixture.service.processQueuedDecision(value.reviewId);
    assert.equal(fixture.publishCalls, 1);
  });

  it('keeps a retryable queued decision durable until a later attempt succeeds', async () => {
    const fixture = createMemoryReviewFixture({
      queued: true,
      retryablePublishFailures: 1,
    });
    await openMemoryReview(fixture, 'proposal-retry', ['Uses dark mode.']);
    const button = findCardButtons(parseCard(fixture.sentCards[0]))
      .find(candidate => candidate.text.content === 'Save to Department: Finance');
    assert.ok(button);
    const value = button.value as Record<string, string>;

    await fixture.service.handle({ action: { value: button.value } }, fixture.actor);
    await assert.rejects(
      () => fixture.service.processQueuedDecision(value.reviewId),
      /Retryable knowledge review decision failure/,
    );
    assert.equal(fixture.publishCalls, 1);
    assert.equal(fixture.updatedCards.length, 0);

    await fixture.service.processQueuedDecision(value.reviewId);
    assert.equal(fixture.publishCalls, 2);
    assert.match(JSON.stringify(parseCard(fixture.updatedCards.at(-1)!)), /Saved 1 reviewed fact/);

    await fixture.service.processQueuedDecision(value.reviewId);
    assert.equal(fixture.publishCalls, 2);
  });

  it('closes and clears a queued review only after retry exhaustion is finalized', async () => {
    const fixture = createMemoryReviewFixture({ queued: true });
    await openMemoryReview(fixture, 'proposal-exhausted', ['Uses dark mode.']);
    const button = findCardButtons(parseCard(fixture.sentCards[0]))
      .find(candidate => candidate.text.content === 'Save to Department: Finance');
    assert.ok(button);
    const value = button.value as Record<string, string>;

    await fixture.service.handle({ action: { value: button.value } }, fixture.actor);
    await fixture.service.finalizeQueuedDecisionFailure(
      value.reviewId,
      new Error('database unavailable'),
    );

    assert.match(JSON.stringify(parseCard(fixture.updatedCards.at(-1)!)), /Memory was not saved/);
    await fixture.service.processQueuedDecision(value.reviewId);
    assert.equal(fixture.publishCalls, 0);
    const duplicate = await fixture.service.handle(
      { action: { value: button.value } },
      fixture.actor,
    );
    assert.equal(duplicate.ok, false);
    assert.match(JSON.stringify(duplicate.responseBody), /expired or was already resolved/);
  });

  it('refreshes mutable role and department authority before a queued decision executes', async () => {
    const fixture = createMemoryReviewFixture({
      queued: true,
      liveQueuedIdentity: {
        userId: 'user-1',
        companyId: 'company-1',
        aiRole: 'COMPANY_ADMIN',
        channel: 'lark',
        activeDepartmentId: 'dept-2',
      },
    });
    await openMemoryReview(fixture, 'proposal-live-rbac', ['Uses dark mode.']);
    const button = findCardButtons(parseCard(fixture.sentCards[0]))
      .find(candidate => candidate.text.content === 'Save to Department: Finance');
    assert.ok(button);
    const value = button.value as Record<string, string>;

    await fixture.service.handle({ action: { value: button.value } }, fixture.actor);
    await fixture.service.processQueuedDecision(value.reviewId);

    assert.equal(fixture.publishRunContext?.['companyRole'], 'COMPANY_ADMIN');
    assert.equal(fixture.publishRunContext?.['departmentId'], 'dept-2');
  });

  it('fails a queued decision closed when the Lark identity is remapped', async () => {
    const fixture = createMemoryReviewFixture({
      queued: true,
      liveQueuedIdentity: {
        userId: 'different-user',
        companyId: 'company-1',
        aiRole: 'MEMBER',
        channel: 'lark',
      },
    });
    await openMemoryReview(fixture, 'proposal-remapped', ['Uses dark mode.']);
    const button = findCardButtons(parseCard(fixture.sentCards[0]))
      .find(candidate => candidate.text.content === 'Save to Department: Finance');
    assert.ok(button);
    const value = button.value as Record<string, string>;

    await fixture.service.handle({ action: { value: button.value } }, fixture.actor);
    await fixture.service.processQueuedDecision(value.reviewId);

    assert.equal(fixture.publishCalls, 0);
    assert.match(JSON.stringify(parseCard(fixture.updatedCards.at(-1)!)), /access to this target changed/i);
  });

  it('does not send a dead interactive card when its callback URL is unconfigured', async () => {
    const fixture = createMemoryReviewFixture({ callbacksConfigured: false });
    const result = await openMemoryReview(
      fixture,
      'proposal-no-callback',
      ['Uses dark mode.'],
    );

    assert.match(result.message, /card callback is not configured/i);
    assert.equal(fixture.sentCards.length, 0);
  });

  it('closes a delivered card when its actionable state cannot be persisted', async () => {
    const fixture = createMemoryReviewFixture({ failCardStatePersist: true });
    const result = await openMemoryReview(fixture, 'proposal-4', ['Uses dark mode.']);
    assert.match(result.message, /could not be opened safely/i);
    assert.match(JSON.stringify(parseCard(fixture.updatedCards[0])), /Memory was not saved/);
    const saveButton = findCardButtons(parseCard(fixture.sentCards[0]))
      .find(button => button.text.content === 'Save to Department: Finance');
    assert.ok(saveButton);
    const replay = await fixture.service.handle(
      { action: { value: saveButton.value } },
      fixture.actor,
    );
    assert.equal(replay.ok, false);
    assert.equal(fixture.publishCalls, 0);
  });

  it('closes a delivered card when its backend run-effect receipt cannot be persisted', async () => {
    const fixture = createMemoryReviewFixture();
    const result = await fixture.service.openMemoryForRuntime({
      proposalId: 'proposal-effect-receipt-failure',
      facts: ['Uses dark mode.'],
      runContext: fixture.runContext,
      perm: fixture.permission,
      chatId: 'chat-1',
      onOpened: async () => {
        throw new Error('shared receipt store unavailable');
      },
    });

    assert.equal(result.opened, false);
    assert.match(result.message, /could not be verified safely/i);
    assert.match(JSON.stringify(parseCard(fixture.updatedCards[0])), /Memory was not saved/);
    const saveButton = findCardButtons(parseCard(fixture.sentCards[0]))
      .find(button => button.text.content === 'Save to Department: Finance');
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
    const result = await openMemoryReview(fixture, 'proposal-5', ['Uses dark mode.']);
    assert.match(result.message, /could not be opened safely/i);
    const saveButton = findCardButtons(parseCard(fixture.sentCards[0]))
      .find(button => button.text.content === 'Save to Department: Finance');
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
    const summary = buildArgsSummary('knowledge', 'create', {
      operation: 'apply',
      kind: 'memory',
      action: 'publish',
      scope: 'company',
      mutationId: 'mutation-1',
      contentHash: 'a'.repeat(64),
      content: { facts: ['Uses dark mode.', 'Weekly finance review is Monday.'] },
    });
    assert.equal(
      summary,
      'Publish 2 reviewed facts to company memory\n1. Uses dark mode.\n2. Weekly finance review is Monday.',
    );
  });
});

function openMemoryReview(
  fixture: ReturnType<typeof createMemoryReviewFixture>,
  proposalId: string,
  facts: readonly string[],
  requestedScope?: 'department' | 'company',
) {
  return fixture.service.openMemoryForRuntime({
    proposalId,
    facts: [...facts],
    runContext: fixture.runContext,
    perm: fixture.permission,
    chatId: 'chat-1',
    ...(requestedScope ? { requestedScope } : {}),
  });
}

function createMemoryReviewFixture(options: {
  publishGate?: Promise<void>;
  failCardStatePersist?: boolean;
  failCompensation?: boolean;
  failCardUpdate?: boolean;
  queued?: boolean;
  callbacksConfigured?: boolean;
  knowledgeTargets?: Array<Record<string, unknown>>;
  liveQueuedIdentity?: {
    userId: string;
    companyId: string;
    aiRole: string;
    channel: string;
    activeDepartmentId?: string;
  } | null;
  retryablePublishFailures?: number;
} = {}) {
  const values = new Map<string, unknown>();
  const sentCards: string[] = [];
  const updatedCards: string[] = [];
  const enqueuedReviewIds: string[] = [];
  let publishArgs: Record<string, unknown> | undefined;
  let publishRunContext: Record<string, unknown> | undefined;
  let publishApprovalGate: unknown;
  let publishCalls = 0;
  let permissionResolutions = 0;
  let setCalls = 0;
  const permission = {
    allowedToolIds: new Set(['knowledge']),
    allowedActionsByTool: new Map([['knowledge', new Set(['read', 'create', 'update', 'delete'])]]),
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
      approvalGate?: unknown;
    }) => {
      if (input.args['operation'] === 'check_targets') {
        return {
          status: 'success',
          toolId: 'knowledge',
          result: {
            operation: 'check_targets',
            targets: options.knowledgeTargets ?? [
              { scope: 'personal', label: 'Personal' },
              { scope: 'department', label: 'Finance', departmentId: 'dept-1' },
              { scope: 'department', label: 'Operations', departmentId: 'dept-2' },
              { scope: 'company', label: 'Company' },
            ],
          },
        };
      }
      if (input.args['operation'] === 'propose') {
        return {
          status: 'success',
          toolId: 'knowledge',
          result: {
            operation: 'propose',
            mutationId: 'mutation-1',
            contentHash: 'a'.repeat(64),
            status: 'awaiting_requester_review',
          },
        };
      }
      publishCalls += 1;
      publishArgs = input.args;
      publishRunContext = input.runContext;
      publishApprovalGate = input.approvalGate;
      if (options.publishGate) await options.publishGate;
      if (publishCalls <= (options.retryablePublishFailures ?? 0)) {
        return {
          status: 'tool_error',
          toolId: 'knowledge',
          message: 'database unavailable',
        };
      }
      return {
        status: 'success',
        toolId: 'knowledge',
        result: input.args['operation'] === 'propose'
          ? { operation: 'propose', status: 'applied', applied: true }
          : { operation: 'apply', status: 'applied', resourceId: 'resource-1', version: 1 },
      };
    },
  };
  const knowledgeMutations = {
    confirmRequesterReview: async () => ({ status: 'awaiting_approval' }),
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
  const actor = {
    userId: 'user-1',
    companyId: 'company-1',
    aiRole: 'MEMBER',
    openId: 'open-1',
    tenantKey: 'tenant-1',
    activeDepartmentId: 'dept-1',
  };
  const service = new LarkKnowledgeReviewService(
    cache as any,
    adapter as any,
    toolExecutor as any,
    permissions as any,
    {} as any,
    knowledgeMutations as any,
    logger as any,
    options.queued ? {
      enqueue: async (reviewId: string) => {
        if (!enqueuedReviewIds.includes(reviewId)) {
          enqueuedReviewIds.push(reviewId);
        }
        return `knowledge_review_${reviewId}`;
      },
    } : undefined,
    options.callbacksConfigured ?? true,
    options.queued ? {
      resolveByLarkTenantIdentity: async () => ({
        ok: true as const,
        value: options.liveQueuedIdentity === null
          ? null
          : options.liveQueuedIdentity ?? {
            userId: actor.userId,
            companyId: actor.companyId,
            aiRole: actor.aiRole,
            channel: 'lark',
            activeDepartmentId: actor.activeDepartmentId,
          },
      }),
    } : undefined,
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
  return {
    service,
    permission,
    runContext,
    actor,
    sentCards,
    updatedCards,
    enqueuedReviewIds,
    get publishArgs() { return publishArgs; },
    get publishRunContext() { return publishRunContext; },
    get publishApprovalGate() { return publishApprovalGate; },
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
  value: unknown;
  confirm?: unknown;
}> {
  const buttons: Array<{ text: { content: string }; value: unknown; confirm?: unknown }> = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const element = value as Record<string, any>;
    if (element.tag === 'button') {
      buttons.push({
        text: element.text,
        value: element.value ?? element.behaviors?.[0]?.value,
        ...(element.confirm ? { confirm: element.confirm } : {}),
      });
    }
    Object.values(element).forEach(visit);
  };
  visit(card.body?.elements ?? card.elements ?? []);
  return buttons;
}
