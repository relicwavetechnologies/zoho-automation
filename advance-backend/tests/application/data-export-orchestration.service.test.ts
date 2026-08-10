import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DataExportOrchestrationService } from '../../src/application/data-export/data-export-orchestration.service.ts';
import type {
  DataExportCandidateRecord,
  DataExportCandidateRepositoryPort,
  DataExportPlanRecord,
  UpsertDataExportPlanInput,
} from '../../src/application/data-export/export-candidate.ts';
import type { DataExportOfferPayload } from '../../src/application/data-export/export-offer.ts';
import type { PermissionResult } from '../../src/application/permissions/permission.types.ts';
import { asDepartmentRoleSlug } from '../../src/domain/permissions/department-role.ts';
import type { ToolActionGroup } from '../../src/domain/permissions/tool-action-group.ts';
import { DataExportCandidateRepository } from '../../src/infrastructure/persistence/data-export-candidate.repository.ts';
import { asDepartmentId, asToolId } from '../../src/shared/ids.ts';
import { ok } from '../../src/shared/result.ts';

const COMPANY_ID = 'co-test';
const USER_ID = 'user-test';
const CHAT_ID = 'oc_chat';
const SEMRUSH_CANDIDATE_ID = '11111111-1111-4111-8111-111111111111';
const ZOHO_CANDIDATE_ID = '22222222-2222-4222-8222-222222222222';
const MENHOOD_CANDIDATE_ID = '55555555-5555-4555-8555-555555555555';
const PLAN_ID = '33333333-3333-4333-8333-333333333333';
const ZOHO_CONNECTION_ID = '44444444-4444-4444-8444-444444444444';

describe('DataExportOrchestrationService', () => {
  it('queues an unknown-size explicit export directly without sampling or reconfirming', async () => {
    const repo = new InMemoryCandidateRepo([
      candidate(SEMRUSH_CANDIDATE_ID, semrushPayload(), { estimatedRows: undefined }),
    ]);
    const submitted: Array<{ payload: DataExportOfferPayload; connectionId?: string }> = [];
    const service = serviceWith({
      repo,
      permission: permissionFor(['dataExport:create', 'semrush:read']),
      submitAuthorized: async (payload, connectionId) => {
        submitted.push({ payload, ...(connectionId ? { connectionId } : {}) });
        return `job-${submitted.length}`;
      },
    });

    const plan = await service.planForActor({
      companyId: COMPANY_ID,
      userId: USER_ID,
      chatId: CHAT_ID,
      plan: {
        datasets: [{ candidateId: SEMRUSH_CANDIDATE_ID }],
        destination: { format: 'google_sheet', title: 'Large Semrush export' },
        userIntent: 'explicit_export',
      },
    });
    assert.deepEqual(plan, {
      status: 'direct_queue',
      planId: PLAN_ID,
      exportJobId: 'job-1',
      destinationLabel: 'Divo company Google account',
    });
    assert.equal(submitted[0]!.payload.exportKind, 'full');
    assert.equal(submitted[0]!.payload.rowLimitOverride, undefined);
    assert.equal(submitted[0]!.payload.sampleOfPlanId, undefined);
    assert.equal(submitted[0]!.payload.destination.title, 'Large Semrush export');
    assert.equal(submitted[0]!.payload.requestId, `${PLAN_ID}:full`);
    assert.equal(submitted.length, 1);
  });

  it('blocks complete Zoho exports when fresh permissions are personalized', async () => {
    const repo = new InMemoryCandidateRepo([
      candidate(ZOHO_CANDIDATE_ID, zohoBooksPayload()),
    ]);
    let queued = false;
    const service = serviceWith({
      repo,
      permission: {
        ...permissionFor(['dataExport:create', 'zohoBooks:read']),
        department: {
          id: asDepartmentId('dept-test'),
          name: 'Sales',
          roleSlug: asDepartmentRoleSlug('member'),
          zohoReadScope: 'personalized',
        },
      },
      submitAuthorized: async () => {
        queued = true;
        return 'should-not-queue';
      },
    });

    const result = await service.planForActor({
      companyId: COMPANY_ID,
      userId: USER_ID,
      chatId: CHAT_ID,
      plan: {
        datasets: [{ candidateId: ZOHO_CANDIDATE_ID }],
        destination: { format: 'xlsx', title: 'Zoho invoices' },
        userIntent: 'explicit_export',
      },
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.status === 'blocked' && result.reason, 'personalized_zoho_scope');
    assert.equal(repo.upsertCount, 0);
    assert.equal(queued, false);
  });

  it('blocks stale truncated Menhood candidates that were created without stable ordering', async () => {
    const repo = new InMemoryCandidateRepo([
      candidate(MENHOOD_CANDIDATE_ID, menhoodPayload(), {
        estimatedRows: undefined,
        coverage: { truncated: true, returnedRows: 25 },
      }),
    ]);
    let queued = false;
    const service = serviceWith({
      repo,
      permission: permissionFor(['dataExport:create', 'menhoodData:read']),
      submitAuthorized: async () => {
        queued = true;
        return 'should-not-queue';
      },
    });

    const result = await service.planForActor({
      companyId: COMPANY_ID,
      userId: USER_ID,
      chatId: CHAT_ID,
      plan: {
        datasets: [{ candidateId: MENHOOD_CANDIDATE_ID }],
        destination: { format: 'xlsx', title: 'Menhood raw export' },
        userIntent: 'explicit_export',
      },
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.status === 'blocked' && result.reason, 'menhood_unordered_candidate');
    assert.match(result.status === 'blocked' ? result.message : '', /ORDER BY/);
    assert.equal(repo.upsertCount, 0);
    assert.equal(queued, false);
  });

  it('blocks stale truncated Menhood order-line candidates whose ordering lacks an id tie-breaker', async () => {
    const repo = new InMemoryCandidateRepo([
      candidate(MENHOOD_CANDIDATE_ID, menhoodPayload(
        'SELECT o.order_number FROM menhood_orders o ORDER BY o.order_number',
      ), {
        estimatedRows: undefined,
        coverage: { truncated: true, returnedRows: 25 },
      }),
    ]);
    const service = serviceWith({
      repo,
      permission: permissionFor(['dataExport:create', 'menhoodData:read']),
      submitAuthorized: async () => 'should-not-queue',
    });

    const result = await service.planForActor({
      companyId: COMPANY_ID,
      userId: USER_ID,
      chatId: CHAT_ID,
      plan: {
        datasets: [{ candidateId: MENHOOD_CANDIDATE_ID }],
        destination: { format: 'xlsx', title: 'Menhood raw export' },
        userIntent: 'explicit_export',
      },
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.status === 'blocked' && result.reason, 'menhood_unordered_candidate');
  });

  it('allows truncated Menhood order-line candidates with a deterministic id tie-breaker', async () => {
    const repo = new InMemoryCandidateRepo([
      candidate(MENHOOD_CANDIDATE_ID, menhoodPayload(
        'SELECT o.order_number FROM menhood_orders o ORDER BY o.order_date, o.order_number, o.id',
      ), {
        estimatedRows: undefined,
        coverage: { truncated: true, returnedRows: 25 },
      }),
    ]);
    const service = serviceWith({
      repo,
      permission: permissionFor(['dataExport:create', 'menhoodData:read']),
      submitAuthorized: async () => 'job-1',
    });

    const result = await service.planForActor({
      companyId: COMPANY_ID,
      userId: USER_ID,
      chatId: CHAT_ID,
      plan: {
        datasets: [{ candidateId: MENHOOD_CANDIDATE_ID }],
        destination: { format: 'xlsx', title: 'Menhood raw export' },
        userIntent: 'explicit_export',
      },
    });

    assert.equal(result.status, 'direct_queue');
  });

  it('lists active candidates with safe planning metadata', async () => {
    const repo = new InMemoryCandidateRepo([
      candidate(SEMRUSH_CANDIDATE_ID, semrushPayload()),
      candidate(ZOHO_CANDIDATE_ID, zohoBooksPayload(), { sourceKind: 'zoho_books' }),
    ]);
    const service = serviceWith({
      repo,
      permission: permissionFor(['dataExport:create', 'semrush:read', 'zohoBooks:read']),
      submitAuthorized: async () => 'unused',
    });

    const listed = await service.listCandidatesForActor({
      companyId: COMPANY_ID,
      userId: USER_ID,
      chatId: CHAT_ID,
    });

    assert.equal(listed.length, 2);
    assert.equal(listed[0]!.candidateId, SEMRUSH_CANDIDATE_ID);
    assert.match(listed[0]!.label, /Semrush/i);
    assert.match(listed[0]!.shapeKey, /domain_overview/);
    assert.match(listed[0]!.argsSummary, /domain_overview/i);
    assert.equal(listed[1]!.candidateId, ZOHO_CANDIDATE_ID);
  });

  it('returns ambiguous when mixed-shape plans omit tabName assignments', async () => {
    const backlinksId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const overviewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const repo = new InMemoryCandidateRepo([
      candidate(backlinksId, semrushBacklinksPayload()),
      candidate(overviewId, semrushDomainOverviewPayload()),
    ]);
    const service = serviceWith({
      repo,
      permission: permissionFor(['dataExport:create', 'semrush:read']),
      submitAuthorized: async () => 'should-not-queue',
    });

    const result = await service.planForActor({
      companyId: COMPANY_ID,
      userId: USER_ID,
      chatId: CHAT_ID,
      plan: {
        datasets: [
          { candidateId: backlinksId },
          { candidateId: overviewId },
        ],
        destination: { format: 'xlsx', title: 'Semrush workbook' },
        userIntent: 'explicit_export',
      },
    });

    assert.equal(result.status, 'ambiguous');
    assert.match(result.status === 'ambiguous' ? result.message : '', /tabName/i);
  });

  it('plans mixed-shape workbook exports when every dataset has tabName', async () => {
    const backlinksId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const overviewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const repo = new InMemoryCandidateRepo([
      candidate(backlinksId, semrushBacklinksPayload()),
      candidate(overviewId, semrushDomainOverviewPayload()),
    ]);
    const submitted: DataExportOfferPayload[] = [];
    const service = serviceWith({
      repo,
      permission: permissionFor(['dataExport:create', 'semrush:read']),
      submitAuthorized: async payload => {
        submitted.push(payload);
        return 'job-1';
      },
    });

    const result = await service.planForActor({
      companyId: COMPANY_ID,
      userId: USER_ID,
      chatId: CHAT_ID,
      plan: {
        datasets: [
          { candidateId: backlinksId, tabName: 'Backlinks' },
          { candidateId: overviewId, tabName: 'Overview' },
        ],
        destination: { format: 'xlsx', title: 'Semrush workbook' },
        userIntent: 'explicit_export',
      },
    });

    assert.equal(result.status, 'direct_queue');
    assert.equal(result.status === 'direct_queue' && result.exportJobId, 'job-1');
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]!.workbookTabs?.length, 2);
    assert.equal(submitted[0]!.workbookTabs?.[0]?.tabName, 'Backlinks');
    assert.equal(submitted[0]!.workbookTabs?.[1]?.tabName, 'Overview');
    assert.equal(
      submitted[0]!.workbookTabs?.[0]?.source.args.operation,
      'backlinks_comparison',
    );
    assert.equal(
      submitted[0]!.workbookTabs?.[1]?.source.args.operation,
      'domain_overview',
    );
  });

  it('queues a large explicit workbook directly within the existing format caps', async () => {
    const backlinksId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const overviewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const repo = new InMemoryCandidateRepo([
      candidate(backlinksId, semrushBacklinksPayload(), { estimatedRows: 3_000 }),
      candidate(overviewId, semrushDomainOverviewPayload(), { estimatedRows: 3_000 }),
    ]);
    const service = serviceWith({
      repo,
      permission: permissionFor(['dataExport:create', 'semrush:read']),
      submitAuthorized: async () => 'job-large',
    });

    const result = await service.planForActor({
      companyId: COMPANY_ID,
      userId: USER_ID,
      chatId: CHAT_ID,
      plan: {
        datasets: [
          { candidateId: backlinksId, tabName: 'Backlinks' },
          { candidateId: overviewId, tabName: 'Overview' },
        ],
        destination: { format: 'xlsx', title: 'Large Semrush workbook' },
        userIntent: 'explicit_export',
      },
    });

    assert.equal(result.status, 'direct_queue');
    assert.equal(result.status === 'direct_queue' && result.exportJobId, 'job-large');
  });
});

describe('DataExportCandidateRepository sample readiness', () => {
  it('treats markSampleReady as idempotent for an already-ready same sample job', async () => {
    const now = new Date('2026-08-04T00:00:00.000Z');
    const row = {
      id: PLAN_ID,
      companyId: COMPANY_ID,
      userId: USER_ID,
      departmentId: null,
      chatId: CHAT_ID,
      conversationKey: null,
      candidateIds: [SEMRUSH_CANDIDATE_ID],
      planJson: {
        datasets: [{ candidateId: SEMRUSH_CANDIDATE_ID }],
        destination: { format: 'google_sheet', title: 'Large Semrush export' },
        userIntent: 'explicit_export',
      },
      planHash: 'plan-hash',
      destinationFormat: 'google_sheet',
      destinationConnectionId: null,
      status: 'sample_ready',
      sampleRows: 100,
      sampleJobId: 'job-1',
      sampleReadyAt: now,
      fullJobId: null,
      sampleConfirmedAt: null,
      expiresAt: new Date('2026-08-05T00:00:00.000Z'),
      createdAt: now,
      updatedAt: now,
    };
    const repository = new DataExportCandidateRepository({
      dataExportCandidate: {},
      dataExportPlan: {
        updateMany: async () => ({ count: 0 }),
        findFirst: async () => row,
      },
    } as any);

    const result = await repository.markSampleReady({
      planId: PLAN_ID,
      companyId: COMPANY_ID,
      userId: USER_ID,
      sampleJobId: 'job-1',
      now,
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value?.status, 'sample_ready');
    assert.equal(result.ok && result.value?.sampleJobId, 'job-1');
  });
});

function serviceWith(input: {
  readonly repo: InMemoryCandidateRepo;
  readonly permission: PermissionResult;
  readonly submitAuthorized: (payload: DataExportOfferPayload, connectionId?: string) => Promise<string>;
}): DataExportOrchestrationService {
  return new DataExportOrchestrationService({
    candidates: input.repo,
    offers: { submitAuthorized: input.submitAuthorized },
    identityRepo: {
      resolveByUserId: async () => ok({
        userId: USER_ID,
        companyId: COMPANY_ID,
        aiRole: 'MEMBER',
        channel: 'lark',
      }),
    },
    permissions: {
      resolve: async () => ok(input.permission),
    },
    resolveDestination: async () => okDestination(),
    now: () => new Date('2026-08-04T00:00:00.000Z'),
  });
}

function permissionFor(entries: readonly `${string}:${ToolActionGroup}`[]): PermissionResult {
  const allowedActionsByTool = new Map();
  for (const entry of entries) {
    const [toolId, action] = entry.split(':') as [string, ToolActionGroup];
    const key = asToolId(toolId);
    const actions = allowedActionsByTool.get(key) ?? new Set<ToolActionGroup>();
    actions.add(action);
    allowedActionsByTool.set(key, actions);
  }
  return {
    allowedToolIds: new Set(allowedActionsByTool.keys()),
    allowedActionsByTool,
    decisions: [],
  };
}

function okDestination() {
  return {
    status: 'selected' as const,
    target: {
      kind: 'company_google' as const,
      connectionId: '55555555-5555-4555-8555-555555555555',
    },
  };
}

function candidate(
  id: string,
  payload: DataExportOfferPayload,
  overrides: Partial<DataExportCandidateRecord> = {},
): DataExportCandidateRecord {
  return {
    id,
    companyId: COMPANY_ID,
    userId: USER_ID,
    chatId: CHAT_ID,
    sourceKind: payload.source.kind,
    sourceConnectionId: payload.source.connectionId,
    payload,
    payloadHash: `${id}:hash`,
    schema: [{ name: 'Name' }],
    previewRowCount: 25,
    estimatedRows: 25,
    status: 'active',
    expiresAt: new Date('2026-08-05T00:00:00.000Z'),
    createdAt: new Date('2026-08-04T00:00:00.000Z'),
    updatedAt: new Date('2026-08-04T00:00:00.000Z'),
    ...overrides,
  };
}

function semrushPayload(): DataExportOfferPayload {
  return {
    companyId: COMPANY_ID,
    userId: USER_ID,
    source: {
      kind: 'semrush_snapshot',
      connectionId: 'backend_managed',
      args: {
        operation: 'domain_overview',
        domain: 'example.com',
        database: 'us',
      },
    },
    destination: { format: 'auto', title: 'Semrush export' },
    chatId: CHAT_ID,
    requestId: 'semrush-request',
  };
}

function semrushBacklinksPayload(): DataExportOfferPayload {
  return {
    ...semrushPayload(),
    source: {
      kind: 'semrush_snapshot',
      connectionId: 'backend_managed',
      args: {
        operation: 'backlinks_comparison',
        targets: ['a.com', 'b.com'],
      },
    },
    requestId: 'semrush-backlinks-request',
  };
}

function semrushDomainOverviewPayload(): DataExportOfferPayload {
  return {
    ...semrushPayload(),
    source: {
      kind: 'semrush_snapshot',
      connectionId: 'backend_managed',
      args: {
        operation: 'domain_overview',
        domain: 'a.com',
        database: 'us',
      },
    },
    requestId: 'semrush-overview-request',
  };
}

function zohoBooksPayload(): DataExportOfferPayload {
  return {
    companyId: COMPANY_ID,
    userId: USER_ID,
    departmentId: 'dept-test',
    source: {
      kind: 'zoho_books',
      connectionId: ZOHO_CONNECTION_ID,
      module: 'invoices',
    },
    destination: { format: 'auto', title: 'Zoho Books export' },
    chatId: CHAT_ID,
    requestId: 'zoho-request',
  };
}

function menhoodPayload(sql = 'SELECT order_number FROM menhood_orders'): DataExportOfferPayload {
  return {
    companyId: COMPANY_ID,
    userId: USER_ID,
    source: {
      kind: 'menhood_query',
      connectionId: 'backend_managed',
      query: {
        sql,
        parameters: [],
      },
      queryFingerprint: 'a'.repeat(64),
    },
    destination: { format: 'auto', title: 'Menhood raw export' },
    chatId: CHAT_ID,
    requestId: 'menhood-request',
  };
}

class InMemoryCandidateRepo implements DataExportCandidateRepositoryPort {
  private plan: DataExportPlanRecord | null;
  upsertCount = 0;

  constructor(
    private readonly candidates: readonly DataExportCandidateRecord[],
    initialPlan: DataExportPlanRecord | null = null,
  ) {
    this.plan = initialPlan;
  }

  async createCandidate() {
    return ok(this.candidates[0]!);
  }

  async loadCandidatesForPlan(input: {
    readonly candidateIds: readonly string[];
    readonly companyId: string;
    readonly userId: string;
    readonly chatId: string;
  }) {
    return ok(input.candidateIds.flatMap(id => {
      const found = this.candidates.find(candidate =>
        candidate.id === id
        && candidate.companyId === input.companyId
        && candidate.userId === input.userId
        && candidate.chatId === input.chatId
      );
      return found ? [found] : [];
    }));
  }

  async listActiveForActor(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly scope?: 'chat' | 'run';
    readonly runRequestId?: string;
    readonly traceId?: string;
    readonly limit?: number;
    readonly now?: Date;
  }) {
    const now = input.now ?? new Date();
    const filtered = this.candidates.filter(candidate =>
      candidate.companyId === input.companyId
      && candidate.userId === input.userId
      && candidate.chatId === input.chatId
      && candidate.status === 'active'
      && candidate.expiresAt > now
      && (input.scope === 'run'
        ? (
          (input.runRequestId && candidate.payload.requestId === input.runRequestId)
          || (input.traceId && candidate.payload.traceId === input.traceId)
          || (!input.runRequestId && !input.traceId)
        )
        : true)
    );
    const limit = input.limit ?? filtered.length;
    return ok(filtered.slice(0, limit));
  }

  async upsertPlan(input: UpsertDataExportPlanInput) {
    this.upsertCount += 1;
    this.plan = this.plan ?? {
      id: PLAN_ID,
      companyId: input.companyId,
      userId: input.userId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      chatId: input.chatId,
      ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
      candidateIds: input.candidateIds,
      plan: input.plan,
      planHash: input.planHash,
      destinationFormat: input.destinationFormat,
      ...(input.destinationConnectionId ? { destinationConnectionId: input.destinationConnectionId } : {}),
      status: 'planned',
      ...(input.sampleRows !== undefined ? { sampleRows: input.sampleRows } : {}),
      expiresAt: input.expiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    };
    return ok(this.plan);
  }

  async loadPlanForActor(input: { readonly planId: string }) {
    return ok(this.plan && this.plan.id === input.planId ? this.plan : null);
  }

  async markSampleQueued(input: { readonly sampleJobId: string; readonly now?: Date }) {
    if (!this.plan || this.plan.status !== 'planned') return ok(null);
    this.plan = {
      ...this.plan,
      status: 'sample_queued',
      sampleJobId: input.sampleJobId,
      updatedAt: input.now ?? this.plan.updatedAt,
    };
    return ok(this.plan);
  }

  async markSampleReady(input: {
    readonly planId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly sampleJobId: string;
    readonly now?: Date;
  }) {
    if (
      !this.plan
      || this.plan.id !== input.planId
      || this.plan.companyId !== input.companyId
      || this.plan.userId !== input.userId
      || this.plan.sampleJobId !== input.sampleJobId
    ) {
      return ok(null);
    }
    if (this.plan.status === 'sample_ready') return ok(this.plan);
    if (this.plan.status !== 'sample_queued') return ok(null);
    this.plan = {
      ...this.plan,
      status: 'sample_ready',
      sampleReadyAt: input.now ?? this.plan.updatedAt,
      updatedAt: input.now ?? this.plan.updatedAt,
    };
    return ok(this.plan);
  }

  async markFullQueued(input: { readonly fullJobId: string; readonly now?: Date }) {
    if (!this.plan || (this.plan.status !== 'planned' && this.plan.status !== 'sample_ready')) return ok(null);
    this.plan = {
      ...this.plan,
      status: 'full_queued',
      fullJobId: input.fullJobId,
      sampleConfirmedAt: input.now ?? this.plan.updatedAt,
      updatedAt: input.now ?? this.plan.updatedAt,
    };
    return ok(this.plan);
  }
}
