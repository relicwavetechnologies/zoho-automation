import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from '../../src/shared/result.ts';
import { DecisionService } from '../../src/application/decision/decision.service.ts';
import { confirmAnswer, confirmQuestion } from '../../src/domain/decision/decision.ts';
import type { Logger } from '../../src/shared/logger.ts';

const logger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child() { return this; },
} as never;

const APPROVER = { userId: 'user-manager', companyId: 'comp-1', displayName: 'Priya Nair' };
const LARK_APPROVAL_METADATA = {
  resolvedManagerUserId: 'user-manager',
  resolvedManagerName: 'Priya Nair',
  resolvedManagerOpenId: 'ou_manager',
  tenantKey: 'tenant-1',
};

/** A manager approval written by the gate — the shape that predates this module. */
function toolActionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-1',
    companyId: 'comp-1',
    conversationId: 'conv-1',
    runId: 'run-1',
    toolId: 'googleGmail',
    actionGroup: 'send',
    kind: 'tool_action',
    summary: 'Send email',
    payloadJson: { toolId: 'googleGmail', action: 'send', args: { to: ['boss@example.com'], subject: 'Q2' }, argsHash: 'h1' },
    metadataJson: {
      resolvedManagerUserId: 'user-manager',
      resolvedManagerName: 'Priya Nair',
      requesterEmail: 'aman@example.com',
      departmentName: 'Finance',
    },
    status: 'pending',
    channel: 'desktop',
    requestedBy: 'user-aman',
    approvedBy: null, approvedAt: null, rejectedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    executionResultJson: null, responseJson: null,
    idempotencyKey: 'idem-1', decisionMessageId: null, resolutionReason: null,
    createdAt: new Date('2026-07-26T10:00:00Z'), updatedAt: new Date('2026-07-26T10:00:00Z'),
    ...overrides,
  };
}

const FLAVOURS = {
  id: 'flavours',
  ask: 'How many flavours?',
  pick: 'one' as const,
  options: [
    { value: 'three', label: 'Three' },
    { value: 'five', label: 'Five' },
  ],
};
const MARKET = {
  id: 'market',
  ask: 'Which market first?',
  pick: 'one' as const,
  options: [
    { value: 'trucks', label: 'Food trucks' },
    { value: 'shops', label: 'Scoop shops' },
  ],
};

/** A question this module asked itself. */
function decisionRow(overrides: Record<string, unknown> = {}) {
  return toolActionRow({
    id: 'decision-1',
    toolId: 'divoDecision',
    actionGroup: 'execute',
    kind: 'decision',
    summary: 'Launch plan',
    payloadJson: { questions: [FLAVOURS, MARKET], continuation: { kind: 'none' } },
    metadataJson: {
      title: 'Launch plan',
      source: 'Divo',
      resolvedManagerUserId: 'user-manager',
      resolvedManagerName: 'Priya Nair',
    },
    ...overrides,
  });
}

function toolRowFromAsk(input: any) {
  return toolActionRow({
    id: 'tool-ask-1',
    toolId: input.toolId,
    actionGroup: input.actionGroup,
    summary: input.summary,
    payloadJson: input.payloadJson,
    metadataJson: input.metadataJson,
    channel: input.channel,
    requestedBy: input.requestedBy,
    status: input.initialStatus,
    idempotencyKey: input.idempotencyKey,
  });
}

function makeService(row: ReturnType<typeof toolActionRow> | null, opts: {
  resolveOk?: boolean;
  partialLands?: boolean;
  businessAction?: unknown;
  createApproval?: (input: any) => ReturnType<typeof toolActionRow>;
  created?: boolean;
  replacedExpired?: boolean;
  courierResult?: unknown;
} = {}) {
  const calls = {
    resolved: [] as unknown[],
    answers: [] as unknown[],
    partials: [] as unknown[],
    resumed: [] as string[],
    cards: [] as unknown[],
    audit: [] as any[],
    created: [] as any[],
    delivered: [] as any[],
    failed: [] as any[],
    checkpoints: [] as any[],
    businessDecisions: [] as any[],
  };
  const service = new DecisionService({
    approvals: {
      findById: async () => ok(row),
      atomicResolve: async (id: string, decision: string, by: string, reason?: string) => {
        calls.resolved.push({ id, decision, by, reason });
        return ok(opts.resolveOk === false ? null : { ...row, status: decision });
      },
      persistAnswer: async (id: string, answer: unknown) => {
        calls.answers.push({ id, answer });
        return ok(undefined);
      },
      persistPartialAnswer: async (id: string, answer: unknown) => {
        calls.partials.push({ id, answer });
        return ok(opts.partialLands !== false);
      },
      listInboxFor: async () => ok({ awaitingMe: row ? [row] : [], requestedByMe: [] }),
      createOrReuseActive: async (input: unknown) => {
        calls.created.push(input);
        return ok({
          approval: opts.createApproval?.(input) ?? decisionRow(),
          created: opts.created !== false,
          replacedExpired: opts.replacedExpired === true,
        });
      },
      setDecisionMessageId: async () => ok(undefined),
      markFailed: async (id: string, reason: string) => {
        calls.failed.push({ id, reason });
        return ok(undefined);
      },
      persistResult: async (id: string, result: unknown) => {
        calls.checkpoints.push({ id, result });
        return ok(undefined);
      },
    } as never,
    resumer: { resume: async (id: string) => { calls.resumed.push(id); } } as never,
    logger,
    audit: { record: (entry: unknown) => { calls.audit.push(entry); } } as never,
    businessActions: {
      decide: async (input: unknown) => {
        calls.businessDecisions.push(input);
        return opts.businessAction ?? { handled: true, response: { ok: true, status: 'ok' } };
      },
    } as never,
    courier: {
      deliver: async (input: unknown) => {
        calls.delivered.push(input);
        return opts.courierResult ?? { ok: true, messageId: 'om_new' };
      },
    },
    onResolvedCard: async (input) => {
      calls.cards.push(input);
    },
  });
  return { service, calls };
}

describe('decisions — reading what is open', () => {
  it('reads an approval written before this module as the question it always was', async () => {
    /* This is what let every existing approval render in the new card on the
       day it shipped, rather than after a migration. */
    const { service } = makeService(toolActionRow());
    const inbox = await service.open(APPROVER);

    const decision = inbox.awaitingMe[0]!;
    assert.equal(decision.title, 'Send email');
    assert.equal(decision.detail, 'To: boss@example.com\nSubject: Q2');
    assert.equal(decision.source, 'aman@example.com');
    assert.equal(decision.questions.length, 1);
    assert.deepEqual(
      (decision.questions[0] as { options: { value: string }[] }).options.map(o => o.value),
      ['yes', 'no'],
    );
  });

  it('reads a decision this module asked as the questions it holds', async () => {
    const { service } = makeService(decisionRow());
    const inbox = await service.open(APPROVER);

    assert.equal(inbox.awaitingMe[0]!.title, 'Launch plan');
    assert.deepEqual(inbox.awaitingMe[0]!.questions.map(q => q.id), ['flavours', 'market']);
  });

  it('projects an automation plan as one exact batch question with its preview', async () => {
    const { service } = makeService(toolActionRow({
      id: 'automation-1',
      toolId: 'automationScript',
      actionGroup: 'execute',
      kind: 'automation_script_plan',
      summary: 'Daily batch: create reports',
      payloadJson: {
        version: 2,
        title: 'Daily batch',
        summary: 'Create the reports.',
        approvalSignature: {
          kind: 'required',
          authority: 'department_manager',
          approverUserId: 'user-manager',
          connectionScope: null,
        },
        invocations: [
          { toolId: 'googleSheets', action: 'create', args: {}, argsHash: 'a'.repeat(64), validation: {}, callSummary: 'Create Leads', approvalSignature: { kind: 'allowed' } },
          { toolId: 'googleGmail', action: 'send', args: {}, argsHash: 'b'.repeat(64), validation: {}, callSummary: 'Send summary', approvalSignature: { kind: 'allowed' } },
        ],
      },
      metadataJson: {
        resolvedManagerUserId: 'user-manager',
        resolvedManagerName: 'Priya Nair',
        planHash: 'plan-hash',
        detail: '**What will happen**\nCreate the reports.\n\n**Exact preflighted calls**\n1. Create Leads\n2. Send summary',
      },
    }));
    const projected = (await service.openRows(APPROVER)).awaitingMe[0]!;

    assert.equal(projected.decision.title, 'Daily batch');
    assert.match(projected.decision.detail ?? '', /Create Leads/);
    assert.match(projected.questions[0]!.ask, /2-call automation plan/);
    assert.deepEqual(projected.continuation, {
      kind: 'run',
      toolId: 'automationScript',
      action: 'execute',
      argsHash: 'plan-hash',
    });
  });

  it('leaves out anything whose deadline has passed', async () => {
    const { service } = makeService(toolActionRow({ expiresAt: new Date(Date.now() - 1_000) }));
    assert.deepEqual((await service.open(APPROVER)).awaitingMe, []);
  });

  it('returns nothing rather than throwing when the query fails', async () => {
    const service = new DecisionService({
      approvals: { listInboxFor: async () => ({ ok: false, error: new Error('db down') }) } as never,
      resumer: { resume: async () => {} } as never,
      logger,
    });
    assert.deepEqual(await service.open(APPROVER), { awaitingMe: [], requestedByMe: [] });
  });
});

describe('decisions — settling', () => {
  it('records the answer and resumes the run', async () => {
    const { service, calls } = makeService(toolActionRow());
    const outcome = await service.settle(APPROVER, 'approval-1', confirmAnswer('approved'));

    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.verdict, 'approved');
    assert.deepEqual(calls.resolved, [{ id: 'approval-1', decision: 'approved', by: 'user-manager', reason: 'Approve' }]);
    assert.deepEqual(calls.resumed, ['approval-1']);
  });

  it('refuses someone the request is not waiting on', async () => {
    const { service, calls } = makeService(toolActionRow());
    const outcome = await service.settle(
      { userId: 'user-someone-else', companyId: 'comp-1' },
      'approval-1',
      confirmAnswer('approved'),
    );

    assert.equal(outcome.ok === false && outcome.reason, 'forbidden');
    assert.equal(calls.resolved.length, 0);
    // The attempt has to survive somewhere an admin can query it.
    assert.equal(calls.audit[0].action, 'decision.unauthorized_actor');
    assert.equal(calls.audit[0].outcome, 'failure');
  });

  it('refuses the right person in the wrong company', async () => {
    const { service, calls } = makeService(toolActionRow());
    const outcome = await service.settle(
      { userId: 'user-manager', companyId: 'comp-other' },
      'approval-1',
      confirmAnswer('approved'),
    );

    assert.equal(outcome.ok === false && outcome.reason, 'forbidden');
    assert.equal(calls.resolved.length, 0);
  });

  it('refuses a Lark card from a different open id', async () => {
    const { service, calls } = makeService(toolActionRow({ metadataJson: LARK_APPROVAL_METADATA }));
    const outcome = await service.settle(
      {
        ...APPROVER,
        lark: { openId: 'ou_someone_else', tenantKey: 'tenant-1' },
      },
      'approval-1',
      confirmAnswer('approved'),
    );

    assert.equal(outcome.ok === false && outcome.reason, 'forbidden');
    assert.equal(outcome.ok === false && outcome.message, 'You are not authorized to approve this request.');
    assert.equal(calls.resolved.length, 0);
    assert.equal(calls.audit[0].action, 'decision.unauthorized_actor');
    assert.equal(calls.audit[0].metadata.expectedApproverOpenId, 'ou_manager');
  });

  it('refuses a Lark card from a different tenant', async () => {
    const { service, calls } = makeService(toolActionRow({ metadataJson: LARK_APPROVAL_METADATA }));
    const outcome = await service.settle(
      {
        ...APPROVER,
        lark: { openId: 'ou_manager', tenantKey: 'tenant-other' },
      },
      'approval-1',
      confirmAnswer('approved'),
    );

    assert.equal(outcome.ok === false && outcome.reason, 'forbidden');
    assert.equal(outcome.ok === false && outcome.message, 'You are not authorized to approve this request.');
    assert.equal(calls.resolved.length, 0);
  });

  it('will not settle a request that is already resolved', async () => {
    const { service, calls } = makeService(toolActionRow({ status: 'approved' }));
    const outcome = await service.settle(APPROVER, 'approval-1', confirmAnswer('rejected'));

    assert.equal(outcome.ok === false && outcome.reason, 'already_resolved');
    assert.equal(calls.resolved.length, 0);
  });

  it('will not settle an expired request', async () => {
    const { service } = makeService(toolActionRow({ expiresAt: new Date(Date.now() - 1_000) }));
    const outcome = await service.settle(APPROVER, 'approval-1', confirmAnswer('approved'));
    assert.equal(outcome.ok === false && outcome.reason, 'expired');
  });

  it('answers plainly when the request is gone', async () => {
    const { service } = makeService(null);
    const outcome = await service.settle(APPROVER, 'approval-1', confirmAnswer('approved'));
    assert.equal(outcome.ok === false && outcome.reason, 'not_found');
  });

  it('accepts a request still in dispatching, as a delivered card may be', async () => {
    const { service, calls } = makeService(toolActionRow({ status: 'dispatching' }));
    const outcome = await service.settle(APPROVER, 'approval-1', confirmAnswer('approved'));

    assert.equal(outcome.ok, true);
    assert.equal(calls.resolved.length, 1);
  });

  it('refuses an answer that does not fit the question, before resolving anything', async () => {
    /* Resolving first and validating after is how a malformed answer used to
       close a request nobody had actually answered. */
    const { service, calls } = makeService(decisionRow());
    const outcome = await service.settle(APPROVER, 'decision-1', {
      responses: [{ questionId: 'flavours', chose: ['seven'] }],
    });

    assert.equal(outcome.ok === false && outcome.reason, 'invalid_answer');
    assert.equal(calls.resolved.length, 0);
  });

  it('refuses a half-finished form', async () => {
    const { service, calls } = makeService(decisionRow());
    const outcome = await service.settle(APPROVER, 'decision-1', {
      responses: [{ questionId: 'flavours', chose: ['three'] }],
    });

    assert.equal(outcome.ok === false && outcome.reason, 'invalid_answer');
    assert.equal(calls.resolved.length, 0);
  });

  it('stores the transcript beside the verdict', async () => {
    const { service, calls } = makeService(decisionRow());
    const answer = {
      responses: [
        { questionId: 'flavours', chose: ['three'] },
        { questionId: 'market', chose: ['trucks'] },
      ],
    };
    const outcome = await service.settle(APPROVER, 'decision-1', answer);

    assert.equal(outcome.ok && outcome.summary, 'Three · Food trucks');
    assert.deepEqual(calls.answers, [{ id: 'decision-1', answer }]);
    // The reason column carries the words, not the option keys.
    assert.equal((calls.resolved[0] as { reason: string }).reason, 'Three · Food trucks');
  });

  it('does not resume a decision that had nothing waiting on it', async () => {
    /* `tell` and `none` have no tool call to re-run. Resuming them would ask
       the resumer to execute a stored action that is not there. */
    const { service, calls } = makeService(decisionRow());
    await service.settle(APPROVER, 'decision-1', {
      responses: [
        { questionId: 'flavours', chose: ['five'] },
        { questionId: 'market', chose: ['shops'] },
      ],
    });
    assert.deepEqual(calls.resumed, []);
  });

  it('stops a delivered card offering buttons for a decision made elsewhere', async () => {
    const { service, calls } = makeService(toolActionRow({ decisionMessageId: 'om_123', channel: 'lark' }));
    await service.settle(APPROVER, 'approval-1', confirmAnswer('rejected'));

    assert.deepEqual(calls.cards, [{
      messageId: 'om_123',
      verdict: 'rejected',
      byName: 'Priya Nair',
      title: 'Send email',
      summary: 'Reject',
      /* A manager approval gets the resolution card its own flow has always
         drawn; only a decision opened by this module gets one carrying what
         was answered, which the approval card has no field for. */
      native: false,
      request: {
        toolId: 'googleGmail',
        action: 'send',
        args: { to: ['boss@example.com'], subject: 'Q2' },
        summary: 'Send email',
        requesterName: 'aman@example.com',
        authority: 'department_manager',
        departmentName: 'Finance',
      },
    }]);
  });

  it('does not resume a gateway approval — the requester retries it themselves', async () => {
    const { service, calls } = makeService(toolActionRow({
      metadataJson: { resolvedManagerUserId: 'user-manager', approvalOrigin: 'gateway' },
    }));
    const outcome = await service.settle(APPROVER, 'approval-1', confirmAnswer('approved'));

    assert.equal(outcome.ok, true);
    assert.deepEqual(calls.resumed, []);
  });

  it('reports failure without resuming when the atomic resolve loses the race', async () => {
    const { service, calls } = makeService(toolActionRow(), { resolveOk: false });
    const outcome = await service.settle(APPROVER, 'approval-1', confirmAnswer('approved'));

    assert.equal(outcome.ok === false && outcome.reason, 'failed');
    assert.deepEqual(calls.resumed, []);
  });

  it('hands a requester confirmation over whole rather than half-settling it', async () => {
    /* That path resolves, claims and executes in one guarded sequence; doing
       any of it here would let the same action run twice. */
    const { service, calls } = makeService(toolActionRow({ kind: 'business_action' }));
    const outcome = await service.settle(
      { ...APPROVER, member: { companyId: 'comp-1', userId: 'user-manager', aiRole: 'admin', sessionId: 's1', channel: 'web', email: null, larkOpenId: null } as never },
      'approval-1',
      confirmAnswer('approved'),
    );

    assert.equal(outcome.ok, true);
    assert.equal(calls.resolved.length, 0);
    assert.equal(calls.businessDecisions.length, 1);
  });

  it('says so plainly when a requester confirmation arrives without a session', async () => {
    const { service } = makeService(toolActionRow({ kind: 'business_action' }));
    const outcome = await service.settle(APPROVER, 'approval-1', confirmAnswer('approved'));
    assert.equal(outcome.ok === false && outcome.reason, 'failed');
  });
});

describe('decisions — one button at a time', () => {
  it('records a press and asks the next question', async () => {
    const { service, calls } = makeService(decisionRow());
    const outcome = await service.answerOne(APPROVER, 'decision-1', 'flavours', 'three');

    assert.equal(outcome.settled, false);
    assert.equal(calls.resolved.length, 0);
    assert.deepEqual(calls.partials, [{
      id: 'decision-1',
      answer: { responses: [{ questionId: 'flavours', chose: ['three'] }] },
    }]);
  });

  it('settles on the press that answers the last question', async () => {
    const { service, calls } = makeService(decisionRow({
      responseJson: { responses: [{ questionId: 'flavours', chose: ['three'] }] },
    }));
    const outcome = await service.answerOne(APPROVER, 'decision-1', 'market', 'trucks');

    assert.equal(outcome.settled, true);
    assert.equal(outcome.settled && outcome.ok && outcome.summary, 'Three · Food trucks');
    assert.equal(calls.resolved.length, 1);
  });

  it('settles immediately on a choice that ends the decision', async () => {
    /* A Reject on the first of three questions is an answer, not an abandoned
       form — so nothing after it is asked. */
    const { service, calls } = makeService(decisionRow({
      payloadJson: {
        questions: [confirmQuestion({ ask: 'Send this?' }), MARKET],
        continuation: { kind: 'none' },
      },
    }));
    const outcome = await service.answerOne(APPROVER, 'decision-1', 'confirm', 'no');

    assert.equal(outcome.settled, true);
    assert.equal(outcome.settled && outcome.ok && outcome.verdict, 'rejected');
    assert.equal(calls.resolved.length, 1);
  });

  it('refuses a press for an option that is not on the card', async () => {
    const { service, calls } = makeService(decisionRow());
    const outcome = await service.answerOne(APPROVER, 'decision-1', 'flavours', 'seven');

    assert.equal(outcome.ok, false);
    assert.equal(calls.answers.length, 0);
  });

  it('refuses a press from someone the request is not waiting on', async () => {
    const { service, calls } = makeService(decisionRow());
    const outcome = await service.answerOne(
      { userId: 'user-someone-else', companyId: 'comp-1' },
      'decision-1', 'flavours', 'three',
    );

    assert.equal(outcome.settled, true);
    assert.equal(outcome.settled && outcome.ok === false && outcome.reason, 'forbidden');
    assert.equal(calls.answers.length, 0);
  });
});

describe('decisions — asking', () => {
  const toolAsk = {
    kind: 'tool_action' as const,
    companyId: 'comp-1',
    approver: { userId: 'user-manager', displayName: 'Priya Nair', larkOpenId: 'ou_manager' },
    requestedBy: { userId: 'user-aman', displayName: 'Aman' },
    summary: 'Send email to boss@example.com',
    toolId: 'googleGmail',
    action: 'send' as const,
    args: { to: ['boss@example.com'], subject: 'Q2' },
    argsHash: 'hash-q2',
    metadata: {
      approvalOrigin: 'cloud_pi',
      sourceChannel: 'lark',
      approvalAuthority: 'department_manager',
      autoResume: false,
      departmentName: 'Finance',
    },
    channel: 'lark' as const,
    conversationKey: 'gateway:scope-1',
    idempotencyKey: 'tool-ask-q2',
    initialStatus: 'dispatching' as const,
  };

  it('writes the row first and cards afterwards', async () => {
    /* The row is the request; the card is a side effect of it. Somebody Divo
       cannot reach still has the question waiting in Divo. */
    const { service, calls } = makeService(null);
    const outcome = await service.ask({
      companyId: 'comp-1',
      approver: { userId: 'user-manager', displayName: 'Priya', larkOpenId: 'ou_1' },
      requestedBy: { userId: 'user-aman', displayName: 'Aman' },
      title: 'Launch plan',
      questions: [FLAVOURS, MARKET],
      continuation: { kind: 'none' },
      channel: 'lark',
      conversationKey: 'oc_1',
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.deliveredVia, 'lark');
    assert.equal(calls.created.length, 1);
    assert.equal(calls.delivered.length, 1);
    assert.equal(calls.created[0].kind, 'decision');
    assert.equal(calls.created[0].metadataJson.resolvedManagerUserId, 'user-manager');
    // Answerable the moment it exists — nothing has to be delivered first.
    assert.equal(calls.created[0].initialStatus, 'pending');
  });

  it('does not card a web decision — the browser reads its own', async () => {
    const { service, calls } = makeService(null);
    const outcome = await service.ask({
      companyId: 'comp-1',
      approver: { userId: 'user-manager', larkOpenId: 'ou_1' },
      requestedBy: { userId: 'user-aman' },
      title: 'Launch plan',
      questions: [FLAVOURS],
      continuation: { kind: 'none' },
      channel: 'web',
      conversationKey: 'web_1',
    });

    assert.equal(outcome.ok && outcome.deliveredVia, 'divo');
    assert.deepEqual(calls.delivered, []);
  });

  it('refuses to open a decision with nothing to answer', async () => {
    const { service, calls } = makeService(null);
    const outcome = await service.ask({
      companyId: 'comp-1',
      approver: { userId: 'user-manager' },
      requestedBy: { userId: 'user-aman' },
      title: 'Nothing',
      questions: [],
      continuation: { kind: 'none' },
      channel: 'web',
      conversationKey: 'web_1',
    });

    assert.equal(outcome.ok, false);
    assert.equal(calls.created.length, 0);
  });

  it('opens a tool approval and sends the shared decision card', async () => {
    const { service, calls } = makeService(null, {
      createApproval: input => toolRowFromAsk(input),
    });
    const outcome = await service.ask(toolAsk);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.deliveredVia, 'lark');
    assert.equal(outcome.ok && outcome.requestState, 'created');
    assert.equal(outcome.ok && outcome.row.kind, 'tool_action');
    assert.equal(calls.created[0].payloadJson.argsHash, 'hash-q2');
    assert.equal(calls.created[0].metadataJson.approvalAuthority, 'department_manager');
    assert.deepEqual(
      (calls.delivered[0].decision.questions[0] as any).options.map((option: any) => option.value),
      ['yes', 'no'],
    );
  });

  it('leaves a no-Lark approver in the Divo inbox without sending a card', async () => {
    const { service, calls } = makeService(null, {
      createApproval: input => toolRowFromAsk(input),
    });
    const outcome = await service.ask({
      ...toolAsk,
      approver: { userId: 'user-manager', displayName: 'Priya Nair', larkOpenId: null },
      channel: 'desktop',
      initialStatus: 'pending',
    });

    assert.equal(outcome.ok && outcome.deliveredVia, 'desktop');
    assert.equal(outcome.ok && outcome.row.channel, 'desktop');
    assert.deepEqual(calls.delivered, []);
  });

  it('preserves a reused tool approval without sending a second card', async () => {
    const { service, calls } = makeService(null, {
      createApproval: input => toolRowFromAsk(input),
      created: false,
    });
    const outcome = await service.ask(toolAsk);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.created, false);
    assert.equal(outcome.ok && outcome.requestState, 'reused');
    assert.deepEqual(calls.delivered, []);
  });

  it('checkpoints uncertain Lark delivery instead of allowing an unsafe retry', async () => {
    const { service, calls } = makeService(null, {
      createApproval: input => toolRowFromAsk(input),
      courierResult: {
        ok: false,
        failure: { certainty: 'unknown', message: 'Lark timed out after accepting the request' },
      },
    });
    const outcome = await service.ask(toolAsk);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'delivery_unknown');
    assert.equal(calls.checkpoints.length, 1);
    assert.equal(calls.checkpoints[0].result.status, 'approval_delivery_unknown');
  });
});

describe('decisions — telling one thread from every other', () => {
  it('names the web thread on a row shaped the way the gate actually writes one', async () => {
    /* The shape matters more than the assertion. A web run's approval stores
       its chat id as `gateway:company:…:thread:web_…:run:…` — a namespacing
       key, not a conversation — and the thread id lives on `execution`, which
       is bound to the signed runtime lease. Reading only the chat ids returned
       null for every real row, so the card this feeds could never appear on
       any thread while its own test passed on a hand-written fixture. */
    const { service } = makeService(toolActionRow({
      metadataJson: {
        resolvedManagerUserId: 'user-manager',
        sourceChatId: 'gateway:company:comp-1:requester:user-aman:thread:web_abcd1234:run:run-1',
        chatId: 'gateway:company:comp-1:requester:user-aman:thread:web_abcd1234:run:run-1:dept:d1',
        execution: { version: 1, threadId: 'web_abcd1234', runId: 'run-1', actionId: 'act-1' },
      },
    }));
    assert.equal((await service.open(APPROVER)).awaitingMe[0]!.threadId, 'web_abcd1234');
  });

  it('names the thread of a decision this module opened', async () => {
    const { service } = makeService(decisionRow({
      metadataJson: {
        title: 'Launch plan',
        resolvedManagerUserId: 'user-manager',
        conversationKey: 'web_abcd1234',
      },
    }));
    assert.equal((await service.open(APPROVER)).awaitingMe[0]!.threadId, 'web_abcd1234');
  });

  it('refuses to read a Lark chat id or a scope key as a thread', async () => {
    /* A manager gate's stored chat id is a namespacing key, not a conversation
       — treating it as one would put an unrelated approval in a composer. */
    for (const chatId of ['oc_9f2b7c', 'gateway:comp-1:user-1', 'scheduled-workflow:42']) {
      const { service } = makeService(toolActionRow({
        metadataJson: { resolvedManagerUserId: 'user-manager', sourceChatId: chatId },
      }));
      assert.equal((await service.open(APPROVER)).awaitingMe[0]!.threadId, null, chatId);
    }
    /* A Lark run's execution context names its own thread, and that is not a
       web thread either — the shape gate is what keeps it out. */
    const lark = makeService(toolActionRow({
      metadataJson: {
        resolvedManagerUserId: 'user-manager',
        execution: { version: 1, threadId: 'agent-seat-7', runId: 'r', actionId: 'a' },
      },
    }));
    assert.equal((await lark.service.open(APPROVER)).awaitingMe[0]!.threadId, null);
  });
});

describe('decisions — asking the same thing twice', () => {
  const base = {
    companyId: 'comp-1',
    approver: { userId: 'user-manager' },
    requestedBy: { userId: 'user-aman' },
    title: 'Approve sending the report',
    continuation: { kind: 'none' as const },
    channel: 'web' as const,
    conversationKey: 'web_abcd1234',
  };

  it('treats a different question as a different request', async () => {
    /* `createOrReuseActive` reuses on an exact key without comparing payloads,
       so a key built from the title alone let a second, different ask return
       the first one's decision — answered and resumed, while its own caller was
       told it had been asked. */
    const { service, calls } = makeService(null);
    await service.ask({ ...base, questions: [FLAVOURS] });
    await service.ask({ ...base, questions: [MARKET] });

    assert.notEqual(calls.created[0].idempotencyKey, calls.created[1].idempotencyKey);
  });

  it('treats the identical question as the same request', async () => {
    const { service, calls } = makeService(null);
    await service.ask({ ...base, questions: [FLAVOURS] });
    await service.ask({ ...base, questions: [FLAVOURS] });

    assert.equal(calls.created[0].idempotencyKey, calls.created[1].idempotencyKey);
  });

  it('lets a caller name the key itself', async () => {
    const { service, calls } = makeService(null);
    await service.ask({ ...base, questions: [FLAVOURS], idempotencyKey: 'mine' });
    assert.equal(calls.created[0].idempotencyKey, 'mine');
  });
});

describe('decisions — a press that arrives too late', () => {
  it('refuses a part-answer once the request has been settled elsewhere', async () => {
    /* Two surfaces hold the same decision. A card press that loaded a moment
       before a browser settled it must not land its half-answer on the finished
       row, leaving a transcript that contradicts the verdict beside it. */
    const { service, calls } = makeService(decisionRow(), { partialLands: false });
    const outcome = await service.answerOne(APPROVER, 'decision-1', 'flavours', 'three');

    assert.equal(outcome.settled, false);
    assert.equal(outcome.ok, false);
    assert.equal(calls.resolved.length, 0);
  });
});

describe('decisions — the card drawn over a settled one', () => {
  it('carries the answer when the decision was opened here', () => {
    /* The approval resolution card can only say approved or rejected. A
       decision that asked three questions and got three answers would have
       been reported as a bare "Approved" over the top of them. */
    const { service, calls } = makeService(decisionRow({ decisionMessageId: 'om_9', channel: 'lark' }));
    return service.settle(APPROVER, 'decision-1', {
      responses: [
        { questionId: 'flavours', chose: ['three'] },
        { questionId: 'market', chose: ['trucks'] },
      ],
    }).then(() => {
      assert.equal((calls.cards[0] as { native: boolean }).native, true);
      assert.equal((calls.cards[0] as { summary: string }).summary, 'Three · Food trucks');
    });
  });
});
