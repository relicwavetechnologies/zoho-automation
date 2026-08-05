import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DataExportOfferService } from '../../src/application/data-export/data-export-offer.service.ts';
import {
  DATA_EXPORT_OFFER_TTL_MS,
  parseDataExportOfferPayload,
  type DataExportOfferPayload,
  type DataExportOfferRecord,
  type DataExportOfferRepositoryPort,
} from '../../src/application/data-export/export-offer.ts';
import {
  datasetSourceSchema,
  datasetSourceShapeKey,
  datasetSourceToolId,
  directDatasetSourceSchema,
  type DataExportJobPayload,
} from '../../src/application/data-export/data-export.types.ts';
import { DataExportOfferRepository } from '../../src/infrastructure/persistence/data-export-offer.repository.ts';
import { ok } from '../../src/shared/result.ts';
import { asToolId } from '../../src/shared/ids.ts';
import {
  dataExportJobId,
  dataExportOfferKey,
  dataExportSpecHash,
} from '../../src/application/data-export/data-export.queue.ts';

const NOW = new Date('2026-08-02T05:00:00.000Z');
const payload: DataExportOfferPayload = {
  companyId: 'company-1',
  userId: 'user-1',
  departmentId: 'department-1',
  source: {
    kind: 'zoho_books',
    connectionId: '11111111-1111-4111-8111-111111111111',
    module: 'invoices',
  },
  destination: { format: 'google_sheet', title: 'Open invoices' },
  chatId: 'oc_chat',
  conversationKey: 'oc_chat:thread:om_root',
  requestId: 'request-1',
};

const storedOffer = (overrides: Partial<DataExportOfferRecord> = {}): DataExportOfferRecord => ({
  id: 'offer-1',
  companyId: payload.companyId,
  userId: payload.userId,
  departmentId: payload.departmentId,
  sourceKind: payload.source.kind,
  sourceConnectionId: payload.source.connectionId,
  payload,
  specHash: 'spec-1',
  idempotencyKey: 'idempotency-1',
  status: 'pending',
  confirmedJobIds: [],
  expiresAt: new Date(NOW.getTime() + DATA_EXPORT_OFFER_TTL_MS),
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const activeIdentity = {
  userId: payload.userId,
  companyId: payload.companyId,
  aiRole: 'MEMBER',
  channel: 'lark' as const,
};

const confirmationDeps = {
  identityRepo: {
    resolveByUserId: async () => ok(activeIdentity),
  },
  permissions: {
    resolve: async () => ok({
      allowedToolIds: new Set([asToolId('dataExport'), asToolId('zohoBooks')]),
      allowedActionsByTool: new Map([
        [asToolId('dataExport'), new Set(['create' as const])],
        [asToolId('zohoBooks'), new Set(['read' as const])],
      ]),
      decisions: [],
    }),
  },
  resolveDestination: async () => ({
    status: 'selected' as const,
    target: {
      kind: 'company_google' as const,
      connectionId: '22222222-2222-4222-8222-222222222222',
    },
  }),
};

describe('Menhood export offer source', () => {
  const menhoodPayload = {
    ...payload,
    source: {
      kind: 'menhood_query' as const,
      connectionId: 'backend_managed' as const,
      query: {
        sql: 'SELECT * FROM menhood_orders WHERE customer_id = $1',
        parameters: ['customer-1'],
        exportTitle: 'Customer orders',
      },
      queryFingerprint: 'a'.repeat(64),
    },
  };

  it('preserves the replay recipe and maps it to Menhood read authority', () => {
    const parsed = parseDataExportOfferPayload(menhoodPayload);

    assert.deepEqual(parsed.source, menhoodPayload.source);
    assert.equal(datasetSourceToolId(parsed.source), 'menhoodData');
    assert.equal(directDatasetSourceSchema.safeParse(parsed.source).success, false);
    assert.notEqual(dataExportSpecHash(parsed), dataExportSpecHash({
      ...parsed,
      source: { ...parsed.source, queryFingerprint: 'b'.repeat(64) },
    }));
    assert.equal(dataExportJobId(parsed), dataExportJobId({
      ...parsed,
      source: { ...parsed.source, queryFingerprint: 'b'.repeat(64) },
    }));
  });

  it('rejects tampered fingerprints, preview rows, and unbounded titles', () => {
    assert.equal(datasetSourceSchema.safeParse({
      ...menhoodPayload.source,
      queryFingerprint: 'not-a-fingerprint',
    }).success, false);
    assert.equal(datasetSourceSchema.safeParse({
      ...menhoodPayload.source,
      previewRows: [{ id: 'must-not-persist' }],
    }).success, false);
    assert.equal(datasetSourceSchema.safeParse({
      ...menhoodPayload.source,
      query: { ...menhoodPayload.source.query, exportTitle: 'x'.repeat(121) },
    }).success, false);
  });
});

describe('parseDataExportOfferPayload workbook tabs', () => {
  it('round-trips workbookTabs for multi-tab workbook exports', () => {
    const workbookPayload = {
      ...payload,
      source: {
        kind: 'semrush_snapshot' as const,
        connectionId: 'backend_managed' as const,
        args: { operation: 'backlinks_comparison' as const, targets: ['a.com', 'b.com'] },
      },
      workbookTabs: [
        {
          tabName: 'Backlinks',
          source: {
            kind: 'semrush_snapshot' as const,
            connectionId: 'backend_managed' as const,
            args: { operation: 'backlinks_comparison' as const, targets: ['a.com', 'b.com'] },
          },
        },
        {
          tabName: 'Overview — a.com',
          source: {
            kind: 'semrush_snapshot' as const,
            connectionId: 'backend_managed' as const,
            args: { operation: 'domain_overview' as const, domain: 'a.com', database: 'in' as const },
          },
        },
      ],
      exportKind: 'sample' as const,
      rowLimitOverride: 100,
    };

    const parsed = parseDataExportOfferPayload(workbookPayload);

    assert.equal(parsed.workbookTabs?.length, 2);
    assert.equal(parsed.workbookTabs?.[0]?.tabName, 'Backlinks');
    assert.equal(parsed.workbookTabs?.[1]?.tabName, 'Overview — a.com');
    assert.equal(parsed.workbookTabs?.[0]?.source.args.operation, 'backlinks_comparison');
    assert.equal(parsed.workbookTabs?.[1]?.source.args.operation, 'domain_overview');
    assert.equal(parsed.exportKind, 'sample');
    assert.equal(parsed.rowLimitOverride, 100);
  });
});

describe('dataset source recipes the provider would reject', () => {
  const bankTransactions = {
    kind: 'zoho_books' as const,
    connectionId: '11111111-2222-4333-8444-555555555555',
    module: 'banktransactions' as const,
  };

  // Zoho Books answers 400 {"code":4,"message":"The account does not exist."}
  // for a status filter with no account, so an offer built from one can only
  // ever fail — after the member has been told the file is on its way.
  it('rejects a bank transaction status filter that names no account', () => {
    for (const filters of [
      { status: 'uncategorized' },
      { filter_by: 'Status.Uncategorized' },
      { status: 'uncategorized', date_start: '2026-07-01' },
    ]) {
      const source = { ...bankTransactions, filters };
      assert.equal(
        datasetSourceSchema.safeParse(source).success,
        false,
        `expected ${JSON.stringify(filters)} to be rejected`,
      );
      // The direct recipe is the path that actually produced the outage, so it
      // has to be gated too, not just the provider-offer union.
      assert.equal(directDatasetSourceSchema.safeParse(source).success, false);
    }
  });

  it('accepts the same filter once the account is named, and unfiltered reads', () => {
    assert.equal(datasetSourceSchema.safeParse({
      ...bankTransactions,
      filters: { status: 'uncategorized', account_id: '3846597000009355454' },
    }).success, true);
    // Verified against the live provider: an unfiltered read needs no account.
    assert.equal(datasetSourceSchema.safeParse(bankTransactions).success, true);
    assert.equal(datasetSourceSchema.safeParse({
      ...bankTransactions,
      filters: { date_start: '2026-07-01' },
    }).success, true);
  });

  it('leaves other Zoho Books modules alone', () => {
    assert.equal(datasetSourceSchema.safeParse({
      ...bankTransactions,
      module: 'invoices' as const,
      filters: { status: 'overdue' },
    }).success, true);
  });
});

describe('direct data export source boundary', () => {
  it('keeps Zoho CRM behind its provider-offer flow', () => {
    const crmSource = {
      kind: 'zoho_crm' as const,
      connectionId: '11111111-2222-4333-8444-555555555555',
      module: 'Deals' as const,
    };

    assert.equal(datasetSourceSchema.safeParse(crmSource).success, true);
    assert.equal(directDatasetSourceSchema.safeParse(crmSource).success, false);
  });
});

const unusedLoad: DataExportOfferRepositoryPort['loadForConfirmation'] = async () =>
  ok({ outcome: 'not_found' });

const confirmableOffer = (overrides: Partial<DataExportOfferRecord> = {}): DataExportOfferRecord =>
  storedOffer({
    id: '11111111-1111-4111-8111-111111111111',
    specHash: dataExportSpecHash(payload),
    idempotencyKey: dataExportOfferKey(payload),
    ...overrides,
  });

describe('DataExportOfferService', () => {
  it('persists a 24-hour immutable recipe before queueing the persisted payload', async () => {
    let createInput: Parameters<DataExportOfferRepositoryPort['create']>[0] | undefined;
    let queued: DataExportJobPayload | undefined;
    let confirmedJobId: string | undefined;
    const offers: DataExportOfferRepositoryPort = {
      create: async (input) => {
        createInput = input;
        return ok({ outcome: 'created', offer: storedOffer({
          payload: input.payload,
          specHash: input.specHash,
          idempotencyKey: input.idempotencyKey,
        }) });
      },
      loadForConfirmation: unusedLoad,
      claimConfirmation: async () => ok({ outcome: 'claimed', offer: storedOffer({
        payload: createInput!.payload,
        specHash: createInput!.specHash,
        idempotencyKey: createInput!.idempotencyKey,
        status: 'confirming',
      }) }),
      markConfirmed: async (input) => {
        confirmedJobId = input.queueJobId;
        return ok(true);
      },
    };
    const service = new DataExportOfferService({
      offers,
      queue: {
        enqueue: async (input) => {
          queued = input;
          return { jobId: 'dtx_job', added: true };
        },
      },
      ...confirmationDeps,
      now: () => NOW,
    });

    const jobId = await service.submitAuthorized(payload);

    assert.equal(jobId, 'dtx_job');
    assert.equal(createInput?.expiresAt.toISOString(), '2026-08-03T05:00:00.000Z');
    assert.deepEqual(createInput?.payload, payload);
    assert.deepEqual(queued, {
      ...payload,
      destination: {
        ...payload.destination,
        target: {
          kind: 'company_google',
          connectionId: '22222222-2222-4222-8222-222222222222',
        },
      },
    });
    assert.equal(confirmedJobId, 'dtx_job');
    assert.equal('progressMessageId' in createInput!.payload, false);
    assert.equal('completedExport' in createInput!.payload, false);
  });

  it('does not persist or queue a direct export while its personal destination is ambiguous', async () => {
    let createCount = 0;
    let enqueueCount = 0;
    const service = new DataExportOfferService({
      offers: {
        create: async () => {
          createCount += 1;
          return ok({ outcome: 'created', offer: storedOffer() });
        },
        loadForConfirmation: unusedLoad,
        claimConfirmation: async () => assert.fail('ambiguous export must not be claimed'),
        markConfirmed: async () => assert.fail('ambiguous export must not be confirmed'),
      },
      queue: {
        enqueue: async () => {
          enqueueCount += 1;
          return { jobId: 'unexpected', added: true };
        },
      },
      identityRepo: confirmationDeps.identityRepo,
      permissions: confirmationDeps.permissions,
      resolveDestination: async () => ({
        status: 'choose_connection',
        connections: [
          {
            connectionId: '33333333-3333-4333-8333-333333333333',
            label: 'Work Google',
            accountEmail: 'member@company.test',
          },
          {
            connectionId: '44444444-4444-4444-8444-444444444444',
            label: 'Personal Google',
            accountEmail: 'member@gmail.com',
          },
        ],
      }),
      now: () => NOW,
    });

    await assert.rejects(
      service.submitAuthorized(payload),
      /choose one Google export account/i,
    );
    assert.equal(createCount, 0);
    assert.equal(enqueueCount, 0);
  });

  it('returns the prior job without queueing a duplicate confirmation', async () => {
    let enqueueCount = 0;
    let createdOffer: DataExportOfferRecord | undefined;
    const service = new DataExportOfferService({
      offers: {
        create: async (input) => {
          createdOffer = storedOffer({
            payload: input.payload,
            specHash: input.specHash,
            idempotencyKey: input.idempotencyKey,
            status: 'confirmed',
            queueJobId: 'dtx_existing',
          });
          return ok({ outcome: 'existing', offer: createdOffer });
        },
        loadForConfirmation: unusedLoad,
        claimConfirmation: async () => ok({
          outcome: 'already_confirmed',
          offer: createdOffer!,
          queueJobId: 'dtx_existing',
        }),
        markConfirmed: async () => assert.fail('already confirmed offer must not be updated'),
      },
      queue: {
        enqueue: async () => {
          enqueueCount += 1;
          return { jobId: 'unexpected', added: true };
        },
      },
      ...confirmationDeps,
      now: () => NOW,
    });

    assert.equal(await service.submitAuthorized(payload), 'dtx_existing');
    assert.equal(enqueueCount, 0);
  });

  it('creates an offer without claiming, confirming, or queueing it', async () => {
    let claims = 0;
    let confirmations = 0;
    let queueCalls = 0;
    let createdOffer: DataExportOfferRecord | undefined;
    const service = new DataExportOfferService({
      offers: {
        create: async (input) => {
          createdOffer = storedOffer({
            payload: input.payload,
            specHash: input.specHash,
            idempotencyKey: input.idempotencyKey,
          });
          return ok({ outcome: 'created', offer: createdOffer });
        },
        loadForConfirmation: unusedLoad,
        claimConfirmation: async () => {
          claims += 1;
          return ok({ outcome: 'claimed', offer: createdOffer! });
        },
        markConfirmed: async () => {
          confirmations += 1;
          return ok(true);
        },
      },
      queue: {
        enqueue: async () => {
          queueCalls += 1;
          return { jobId: 'unexpected', added: true };
        },
      },
      ...confirmationDeps,
      now: () => NOW,
    });

    const offer = await service.createAuthorizedOffer(payload);

    assert.equal(offer.offerId, 'offer-1');
    assert.equal(offer.expiresAt.toISOString(), '2026-08-03T05:00:00.000Z');
    assert.equal(claims, 0);
    assert.equal(confirmations, 0);
    assert.equal(queueCalls, 0);
  });

  it('rejects a conflicting recipe before claim or queue', async () => {
    let claimCount = 0;
    let enqueueCount = 0;
    const service = new DataExportOfferService({
      offers: {
        create: async (input) => ok({ outcome: 'existing', offer: storedOffer({
          payload: input.payload,
          specHash: 'different-spec',
          idempotencyKey: input.idempotencyKey,
        }) }),
        loadForConfirmation: unusedLoad,
        claimConfirmation: async () => {
          claimCount += 1;
          return ok({ outcome: 'not_found' });
        },
        markConfirmed: async () => ok(false),
      },
      queue: {
        enqueue: async () => {
          enqueueCount += 1;
          return { jobId: 'unexpected', added: true };
        },
      },
      ...confirmationDeps,
      now: () => NOW,
    });

    await assert.rejects(
      service.submitAuthorized(payload),
      /only one data export can be queued per user request/i,
    );
    assert.equal(claimCount, 0);
    assert.equal(enqueueCount, 0);
  });

  it('queues only the immutable stored recipe with the actor-selected output format', async () => {
    const offer = confirmableOffer();
    let loadInput: Parameters<DataExportOfferRepositoryPort['loadForConfirmation']>[0] | undefined;
    let permissionInput: unknown;
    let destinationInput: unknown;
    let queued: DataExportOfferPayload | undefined;
    let confirmationInput: unknown;
    let rememberedDestination: unknown;
    const service = new DataExportOfferService({
      offers: {
        create: async () => assert.fail('confirmation must not create another offer'),
        loadForConfirmation: async (input) => {
          loadInput = input;
          return ok({ outcome: 'found', offer });
        },
        claimConfirmation: async () => ok({
          outcome: 'claimed',
          offer: { ...offer, status: 'confirming' },
        }),
        markConfirmed: async (input) => {
          confirmationInput = input;
          return ok(true);
        },
      },
      queue: {
        enqueue: async (input) => {
          queued = input;
          return { jobId: 'dtx_confirmed', added: true };
        },
      },
      identityRepo: confirmationDeps.identityRepo,
      permissions: {
        resolve: async (input) => {
          permissionInput = input;
          return confirmationDeps.permissions.resolve();
        },
      },
      resolveDestination: async (input) => {
        destinationInput = input;
        return {
          status: 'selected',
          target: {
            kind: 'user_google',
            connectionId: '33333333-3333-4333-8333-333333333333',
          },
        };
      },
      rememberDestination: async input => {
        rememberedDestination = input;
      },
      now: () => NOW,
    });

    const result = await service.confirmForActor({
      offerId: offer.id,
      companyId: payload.companyId,
      userId: payload.userId,
      chatId: payload.chatId,
      progressMessageId: 'om_export_card',
      destinationFormat: 'csv',
      destinationConnectionId: '33333333-3333-4333-8333-333333333333',
      rememberExplicitPersonalDestination: true,
    });

    assert.deepEqual(result, { exportJobId: 'dtx_confirmed', disposition: 'queued' });
    assert.deepEqual(queued, {
      ...payload,
      destination: {
        ...payload.destination,
        format: 'csv',
        target: {
          kind: 'user_google',
          connectionId: '33333333-3333-4333-8333-333333333333',
        },
      },
      progressMessageId: 'om_export_card',
    });
    assert.deepEqual(loadInput, {
      offerId: offer.id,
      companyId: payload.companyId,
      userId: payload.userId,
      now: NOW,
    });
    assert.deepEqual(permissionInput, {
      companyId: payload.companyId,
      userId: payload.userId,
      companyRole: 'MEMBER',
      departmentId: payload.departmentId,
      channel: 'lark',
    });
    assert.deepEqual(destinationInput, {
      companyId: payload.companyId,
      userId: payload.userId,
      connectionId: '33333333-3333-4333-8333-333333333333',
    });
    assert.deepEqual(confirmationInput, {
      offerId: offer.id,
      companyId: payload.companyId,
      userId: payload.userId,
      queueJobId: 'dtx_confirmed',
      confirmedAt: NOW,
    });
    assert.deepEqual(rememberedDestination, {
      companyId: payload.companyId,
      userId: payload.userId,
      connectionId: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('does not remember an explicit destination when another confirmation already won', async () => {
    const offer = confirmableOffer();
    let rememberCount = 0;
    const service = new DataExportOfferService({
      offers: {
        create: async () => assert.fail('confirmation must not create another offer'),
        loadForConfirmation: async () => ok({ outcome: 'found', offer }),
        claimConfirmation: async () => ok({
          outcome: 'already_confirmed',
          offer: { ...offer, status: 'confirmed', queueJobId: 'dtx_existing' },
          queueJobId: 'dtx_existing',
        }),
        markConfirmed: async () => assert.fail('already confirmed offer must not be updated'),
      },
      queue: { enqueue: async () => assert.fail('already confirmed offer must not queue') },
      ...confirmationDeps,
      rememberDestination: async () => {
        rememberCount += 1;
      },
      now: () => NOW,
    });

    assert.deepEqual(await service.confirmForActor({
      offerId: offer.id,
      companyId: payload.companyId,
      userId: payload.userId,
      chatId: payload.chatId,
      destinationConnectionId: '33333333-3333-4333-8333-333333333333',
      rememberExplicitPersonalDestination: true,
    }), { exportJobId: 'dtx_existing', disposition: 'already_confirmed' });
    assert.equal(rememberCount, 0);
  });

  it('queues a trusted existing Sheet target without running account selection', async () => {
    const offer = confirmableOffer();
    let queued: DataExportJobPayload | undefined;
    let destinationResolutionCount = 0;
    const destinationTarget = {
      kind: 'existing_google_sheet' as const,
      connectionId: '33333333-3333-4333-8333-333333333333',
      spreadsheetId: 'sheet_1',
      gid: '42',
      mode: 'new_tab' as const,
    };
    const service = new DataExportOfferService({
      offers: {
        create: async () => assert.fail('confirmation must not create another offer'),
        loadForConfirmation: async () => ok({ outcome: 'found', offer }),
        claimConfirmation: async () => ok({ outcome: 'claimed', offer }),
        markConfirmed: async () => ok(true),
      },
      queue: {
        enqueue: async input => {
          queued = input;
          return { jobId: 'dtx_existing_sheet', added: true };
        },
      },
      identityRepo: confirmationDeps.identityRepo,
      permissions: confirmationDeps.permissions,
      resolveDestination: async () => {
        destinationResolutionCount += 1;
        return { status: 'connect_required' };
      },
      now: () => NOW,
    });

    assert.deepEqual(await service.confirmForActor({
      offerId: offer.id,
      companyId: payload.companyId,
      userId: payload.userId,
      chatId: payload.chatId,
      destinationTarget,
    }), { exportJobId: 'dtx_existing_sheet', disposition: 'queued' });
    assert.equal(destinationResolutionCount, 0);
    assert.deepEqual(queued?.destination, {
      ...payload.destination,
      format: 'google_sheet',
      target: destinationTarget,
    });
  });

  it('asks the actor to choose among writable Google accounts before claiming', async () => {
    const offer = confirmableOffer();
    let claimCount = 0;
    let enqueueCount = 0;
    const service = new DataExportOfferService({
      offers: {
        create: async () => assert.fail('confirmation must not create another offer'),
        loadForConfirmation: async () => ok({ outcome: 'found', offer }),
        claimConfirmation: async () => {
          claimCount += 1;
          return ok({ outcome: 'claimed', offer });
        },
        markConfirmed: async () => assert.fail('unselected exports must not be confirmed'),
      },
      queue: {
        enqueue: async () => {
          enqueueCount += 1;
          return { jobId: 'unexpected', added: true };
        },
      },
      identityRepo: confirmationDeps.identityRepo,
      permissions: confirmationDeps.permissions,
      resolveDestination: async () => ({
        status: 'choose_connection',
        connections: [
          {
            connectionId: '33333333-3333-4333-8333-333333333333',
            label: 'Work Google',
            accountEmail: 'member@company.test',
          },
          {
            connectionId: '44444444-4444-4444-8444-444444444444',
            label: 'Personal Google',
            accountEmail: 'member@gmail.com',
          },
        ],
      }),
      now: () => NOW,
    });

    assert.deepEqual(await service.confirmForActor({
      offerId: offer.id,
      companyId: payload.companyId,
      userId: payload.userId,
      chatId: payload.chatId,
    }), {
      disposition: 'choose_destination',
      connections: [
        {
          connectionId: '33333333-3333-4333-8333-333333333333',
          label: 'Work Google',
          accountEmail: 'member@company.test',
        },
        {
          connectionId: '44444444-4444-4444-8444-444444444444',
          label: 'Personal Google',
          accountEmail: 'member@gmail.com',
        },
      ],
    });
    assert.equal(claimCount, 0);
    assert.equal(enqueueCount, 0);
  });

  it('returns the trusted reply target for OAuth before claiming an export', async () => {
    const threadedPayload: DataExportOfferPayload = {
      ...payload,
      replyToMessageId: 'om_thread_root',
      replyInThread: true,
    };
    const offer = confirmableOffer({
      payload: threadedPayload,
      specHash: dataExportSpecHash(threadedPayload),
      idempotencyKey: dataExportOfferKey(threadedPayload),
    });
    let claimCount = 0;
    const service = new DataExportOfferService({
      offers: {
        create: async () => assert.fail('confirmation must not create another offer'),
        loadForConfirmation: async () => ok({ outcome: 'found', offer }),
        claimConfirmation: async () => {
          claimCount += 1;
          return ok({ outcome: 'claimed', offer });
        },
        markConfirmed: async () => assert.fail('unconnected exports must not be confirmed'),
      },
      queue: { enqueue: async () => assert.fail('unconnected exports must not queue') },
      identityRepo: confirmationDeps.identityRepo,
      permissions: confirmationDeps.permissions,
      resolveDestination: async () => ({ status: 'connect_required' }),
      now: () => NOW,
    });

    assert.deepEqual(await service.confirmForActor({
      offerId: offer.id,
      companyId: payload.companyId,
      userId: payload.userId,
      chatId: payload.chatId,
    }), {
      disposition: 'connect_required',
      replyInThread: true,
      replyToMessageId: 'om_thread_root',
    });
    assert.equal(claimCount, 0);
  });

  it('replays an already-confirmed offer without queueing or mutating it', async () => {
    const offer = confirmableOffer({ status: 'confirmed', queueJobId: 'dtx_existing' });
    let enqueueCount = 0;
    const service = new DataExportOfferService({
      offers: {
        create: async () => assert.fail('confirmation must not create another offer'),
        loadForConfirmation: async () => ok({ outcome: 'found', offer }),
        claimConfirmation: async () => ok({
          outcome: 'already_confirmed',
          offer,
          queueJobId: 'dtx_existing',
        }),
        markConfirmed: async () => assert.fail('confirmed offers must not be updated'),
      },
      queue: {
        enqueue: async () => {
          enqueueCount += 1;
          return { jobId: 'unexpected', added: true };
        },
      },
      ...confirmationDeps,
      now: () => NOW,
    });

    assert.deepEqual(await service.confirmForActor({
      offerId: offer.id,
      companyId: payload.companyId,
      userId: payload.userId,
      chatId: payload.chatId,
    }), { exportJobId: 'dtx_existing', disposition: 'already_confirmed' });
    assert.equal(enqueueCount, 0);
  });

  it('acknowledges a concurrent confirmation without entering the enqueue path twice', async () => {
    const offer = confirmableOffer();
    let claimed = false;
    let enqueueCount = 0;
    let releaseFirst!: () => void;
    const firstEnqueueReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const service = new DataExportOfferService({
      offers: {
        create: async () => assert.fail('confirmation must not create another offer'),
        loadForConfirmation: async () => ok({ outcome: 'found', offer }),
        claimConfirmation: async () => {
          if (claimed) return ok({ outcome: 'in_progress', offer: { ...offer, status: 'confirming' } });
          claimed = true;
          return ok({ outcome: 'claimed', offer: { ...offer, status: 'confirming' } });
        },
        markConfirmed: async () => ok(true),
      },
      queue: {
        enqueue: async () => {
          enqueueCount += 1;
          await firstEnqueueReleased;
          return { jobId: 'dtx_confirmed', added: true };
        },
      },
      ...confirmationDeps,
      now: () => NOW,
    });
    const input = {
      offerId: offer.id,
      companyId: payload.companyId,
      userId: payload.userId,
      chatId: payload.chatId,
    };

    const first = service.confirmForActor(input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = await service.confirmForActor(input);

    assert.deepEqual(second, {
      disposition: 'in_progress',
    });
    assert.equal(enqueueCount, 1);
    releaseFirst();
    assert.deepEqual(await first, { exportJobId: 'dtx_confirmed', disposition: 'queued' });
  });

  for (const scenario of [
    {
      name: 'inactive requester identity',
      identity: null,
      permissions: confirmationDeps.permissions.resolve,
      error: /no longer has active company access/i,
    },
    {
      name: 'revoked export permission',
      identity: activeIdentity,
      permissions: async () => ok({
        allowedToolIds: new Set([asToolId('zohoBooks')]),
        allowedActionsByTool: new Map([[asToolId('zohoBooks'), new Set(['read' as const])]]),
        decisions: [],
      }),
      error: /export permission was revoked/i,
    },
    {
      name: 'revoked source permission',
      identity: activeIdentity,
      permissions: async () => ok({
        allowedToolIds: new Set([asToolId('dataExport')]),
        allowedActionsByTool: new Map([[asToolId('dataExport'), new Set(['create' as const])]]),
        decisions: [],
      }),
      error: /read permission was revoked/i,
    },
    {
      name: 'personalized Zoho scope',
      identity: activeIdentity,
      permissions: async () => ok({
        allowedToolIds: new Set([asToolId('dataExport'), asToolId('zohoBooks')]),
        allowedActionsByTool: new Map([
          [asToolId('dataExport'), new Set(['create' as const])],
          [asToolId('zohoBooks'), new Set(['read' as const])],
        ]),
        decisions: [],
        department: {
          id: payload.departmentId,
          name: 'Finance',
          roleSlug: 'MEMBER',
          zohoReadScope: 'personalized' as const,
        },
      }),
      error: /full company Zoho read scope/i,
    },
  ]) {
    it(`rejects ${scenario.name} before claiming or queueing`, async () => {
      const offer = confirmableOffer();
      let claimCount = 0;
      let enqueueCount = 0;
      const service = new DataExportOfferService({
        offers: {
          create: async () => assert.fail('confirmation must not create another offer'),
          loadForConfirmation: async () => ok({ outcome: 'found', offer }),
          claimConfirmation: async () => {
            claimCount += 1;
            return ok({ outcome: 'claimed', offer });
          },
          markConfirmed: async () => assert.fail('rejected offers must not be updated'),
        },
        queue: {
          enqueue: async () => {
            enqueueCount += 1;
            return { jobId: 'unexpected', added: true };
          },
        },
        identityRepo: {
          resolveByUserId: async () => ok(scenario.identity),
        },
        permissions: { resolve: scenario.permissions },
        resolveDestination: confirmationDeps.resolveDestination,
        now: () => NOW,
      });

      await assert.rejects(service.confirmForActor({
        offerId: offer.id,
        companyId: payload.companyId,
        userId: payload.userId,
        chatId: payload.chatId,
      }), scenario.error);
      assert.equal(claimCount, 0);
      assert.equal(enqueueCount, 0);
    });
  }

  it('confirms a natural-language format against the active chat offer', async () => {
    const offer = confirmableOffer();
    let lookupInput: unknown;
    let loadedInput: unknown;
    let claimInput: unknown;
    let queuedPayload: DataExportJobPayload | undefined;
    const service = new DataExportOfferService({
      offers: {
        create: async () => assert.fail('natural confirmation must not create an offer'),
        findActiveForActor: async input => {
          lookupInput = input;
          return ok([offer]);
        },
        loadForConfirmation: async input => {
          loadedInput = input;
          return ok({ outcome: 'found', offer });
        },
        claimConfirmation: async input => {
          claimInput = input;
          return ok({ outcome: 'claimed', offer: { ...offer, status: 'confirming' } });
        },
        markConfirmed: async () => ok(true),
      },
      queue: {
        enqueue: async input => {
          queuedPayload = input;
          return { jobId: 'job-x', added: true };
        },
      },
      ...confirmationDeps,
      now: () => NOW,
    });

    const result = await service.confirmLatestForActor({
      companyId: payload.companyId,
      userId: payload.userId,
      chatId: payload.chatId,
      destinationFormat: 'xlsx',
    });

    assert.deepEqual(result, {
      disposition: 'queued',
      offerId: offer.id,
      exportJobId: 'job-x',
    });
    assert.deepEqual(lookupInput, {
      companyId: payload.companyId,
      userId: payload.userId,
      chatId: payload.chatId,
      now: NOW,
    });
    assert.deepEqual(loadedInput, {
      offerId: offer.id,
      companyId: payload.companyId,
      userId: payload.userId,
      now: NOW,
    });
    assert.equal((claimInput as { requestedJobId: string }).requestedJobId, dataExportJobId({
      ...payload,
      destination: { ...payload.destination, format: 'xlsx' },
    }));
    assert.equal(queuedPayload?.destination.format, 'xlsx');
  });

  it('refuses to guess when several active chat offers match', async () => {
    const first = confirmableOffer({
      payload: { ...payload, destination: { ...payload.destination, title: 'First' } },
    });
    const second = confirmableOffer({
      id: 'offer-2',
      createdAt: new Date(NOW.getTime() + 1_000),
      payload: { ...payload, destination: { ...payload.destination, title: 'Second' } },
    });
    const service = new DataExportOfferService({
      offers: {
        create: async () => assert.fail('ambiguous confirmation must not create an offer'),
        findActiveForActor: async () => ok([first, second]),
        loadForConfirmation: async () => assert.fail('ambiguous confirmation must not load an offer'),
        claimConfirmation: async () => assert.fail('ambiguous confirmation must not claim an offer'),
        markConfirmed: async () => assert.fail('ambiguous confirmation must not mark an offer'),
      },
      queue: { enqueue: async () => assert.fail('ambiguous confirmation must not queue') },
      ...confirmationDeps,
      now: () => NOW,
    });

    assert.deepEqual(await service.confirmLatestForActor({
      companyId: payload.companyId,
      userId: payload.userId,
      chatId: payload.chatId,
      destinationFormat: 'csv',
    }), {
      disposition: 'ambiguous',
      offers: [
        { offerId: first.id, title: 'First', sourceKind: 'zoho_books', createdAt: NOW.toISOString() },
        { offerId: second.id, title: 'Second', sourceKind: 'zoho_books', createdAt: new Date(NOW.getTime() + 1_000).toISOString() },
      ],
      moreAvailable: false,
    });
  });
});

describe('DataExportOfferRepository', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'offer-1',
    companyId: payload.companyId,
    userId: payload.userId,
    departmentId: payload.departmentId,
    sourceKind: payload.source.kind,
    sourceConnectionId: payload.source.connectionId,
    payloadJson: payload,
    specHash: 'spec-1',
    idempotencyKey: 'idempotency-1',
    status: 'pending',
    queueJobId: null,
    confirmedJobIds: [] as string[],
    expiresAt: new Date(NOW.getTime() + DATA_EXPORT_OFFER_TTL_MS),
    confirmedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

  it('recovers a tenant-scoped existing offer after a unique race', async () => {
    let lookup: unknown;
    const repository = new DataExportOfferRepository({
      dataExportOffer: {
        create: async () => {
          throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        },
        findUnique: async (input: unknown) => {
          lookup = input;
          return row();
        },
      },
    } as any);

    const result = await repository.create({
      companyId: payload.companyId,
      userId: payload.userId,
      departmentId: payload.departmentId,
      sourceKind: payload.source.kind,
      sourceConnectionId: payload.source.connectionId,
      payload,
      specHash: 'spec-1',
      idempotencyKey: 'idempotency-1',
      now: NOW,
      expiresAt: row().expiresAt,
    });

    assert.equal(result.ok && result.value.outcome, 'existing');
    assert.deepEqual((lookup as any).where, {
      companyId_idempotencyKey: {
        companyId: payload.companyId,
        idempotencyKey: 'idempotency-1',
      },
    });
  });

  it('loads an offer only within its tenant and actor scope', async () => {
    let lookup: unknown;
    const repository = new DataExportOfferRepository({
      dataExportOffer: {
        findFirst: async (input: unknown) => {
          lookup = input;
          return row();
        },
      },
    } as any);

    const result = await repository.loadForConfirmation({
      offerId: 'offer-1',
      companyId: payload.companyId,
      userId: payload.userId,
      now: NOW,
    });

    assert.equal(result.ok && result.value.outcome, 'found');
    assert.deepEqual((lookup as any).where, {
      id: 'offer-1',
      companyId: payload.companyId,
      userId: payload.userId,
    });
  });

  it('finds active offers within the tenant, actor, and Lark chat', async () => {
    let lookup: unknown;
    const repository = new DataExportOfferRepository({
      dataExportOffer: {
        findMany: async (input: unknown) => {
          lookup = input;
          return [row()];
        },
      },
    } as any);

    const result = await repository.findActiveForActor({
      companyId: payload.companyId,
      userId: payload.userId,
      chatId: payload.chatId,
      now: NOW,
    });

    assert.equal(result.ok, true);
    assert.equal(result.value.length, 1);
    assert.deepEqual((lookup as any).where, {
      companyId: payload.companyId,
      userId: payload.userId,
      status: { in: ['pending', 'confirming', 'confirmed'] },
      expiresAt: { gt: NOW },
      payloadJson: { path: ['chatId'], equals: payload.chatId },
    });
    assert.deepEqual((lookup as any).orderBy, { createdAt: 'desc' });
    assert.equal((lookup as any).take, 9);
  });

  it('claims a live offer with tenant and actor isolation', async () => {
    let claimInput: unknown;
    let lookupInput: unknown;
    const repository = new DataExportOfferRepository({
      dataExportOffer: {
        updateMany: async (input: unknown) => {
          claimInput = input;
          return { count: 1 };
        },
        findFirst: async (input: unknown) => {
          lookupInput = input;
          return row({ status: 'confirming' });
        },
      },
    } as any);

    const result = await repository.claimConfirmation({
      offerId: 'offer-1',
      companyId: payload.companyId,
      userId: payload.userId,
      now: NOW,
    });

    assert.equal(result.ok && result.value.outcome, 'claimed');
    assert.deepEqual((claimInput as any).where, {
      id: 'offer-1',
      companyId: payload.companyId,
      userId: payload.userId,
      status: 'pending',
      expiresAt: { gt: NOW },
    });
    assert.deepEqual((lookupInput as any).where, {
      id: 'offer-1',
      companyId: payload.companyId,
      userId: payload.userId,
    });
  });

  it('does not let a concurrent caller reclaim a live confirmation lease', async () => {
    const updates: unknown[] = [];
    const repository = new DataExportOfferRepository({
      dataExportOffer: {
        updateMany: async (input: unknown) => {
          updates.push(input);
          return { count: 0 };
        },
        findFirst: async () => row({ status: 'confirming', updatedAt: NOW }),
      },
    } as any);

    const result = await repository.claimConfirmation({
      offerId: 'offer-1',
      companyId: payload.companyId,
      userId: payload.userId,
      now: NOW,
    });

    assert.equal(result.ok && result.value.outcome, 'in_progress');
    assert.equal(updates.length, 2);
    assert.deepEqual((updates[1] as any).where.updatedAt, {
      lte: new Date(NOW.getTime() - 60_000),
    });
  });

  it('reclaims a stale confirmation lease so an interrupted queue attempt can recover', async () => {
    let updateCount = 0;
    const repository = new DataExportOfferRepository({
      dataExportOffer: {
        updateMany: async () => ({ count: updateCount++ === 0 ? 0 : 1 }),
        findFirst: async () => row({
          status: 'confirming',
          updatedAt: new Date(NOW.getTime() - 61_000),
        }),
      },
    } as any);

    const result = await repository.claimConfirmation({
      offerId: 'offer-1',
      companyId: payload.companyId,
      userId: payload.userId,
      now: NOW,
    });

    assert.equal(result.ok && result.value.outcome, 'claimed');
    assert.equal(updateCount, 2);
  });

  it('deletes an expired confirmed recipe instead of reusing its prior job', async () => {
    const updates: unknown[] = [];
    const repository = new DataExportOfferRepository({
      dataExportOffer: {
        updateMany: async (input: unknown) => {
          updates.push(input);
          return { count: 0 };
        },
        findFirst: async () => row({
          status: 'confirmed',
          queueJobId: 'dtx_old',
          expiresAt: NOW,
        }),
        deleteMany: async (input: unknown) => {
          updates.push(input);
          return { count: 1 };
        },
      },
    } as any);

    const result = await repository.claimConfirmation({
      offerId: 'offer-1',
      companyId: payload.companyId,
      userId: payload.userId,
      now: NOW,
    });

    assert.deepEqual(result, { ok: true, value: { outcome: 'expired' } });
    assert.equal(updates.length, 2);
    assert.deepEqual((updates[1] as any).where, {
      id: 'offer-1',
      companyId: payload.companyId,
      userId: payload.userId,
      OR: [
        { status: 'expired' },
        { expiresAt: { lte: NOW } },
      ],
    });
  });
});

describe('Multi-call exports fold into one offer', () => {
  const semrushPayload = (domain: string): DataExportOfferPayload => ({
    ...payload,
    source: {
      kind: 'semrush_snapshot',
      connectionId: 'backend_managed',
      args: { operation: 'domain_overview', domain },
    },
    destination: { format: 'auto', title: 'Domain overviews' },
  });

  /** Minimal stand-in for the offer table, keyed the way Postgres keys it. */
  const fakeRepo = () => {
    const rows = new Map<string, DataExportOfferRecord>();
    const repo: DataExportOfferRepositoryPort & { rows: typeof rows } = {
      rows,
      create: async (input) => {
        const key = `${input.companyId}:${input.idempotencyKey}`;
        const existing = rows.get(key);
        if (existing) return ok({ outcome: 'existing', offer: existing });
        const offer = storedOffer({
          id: `offer-${rows.size + 1}`,
          sourceKind: input.payload.source.kind,
          sourceConnectionId: input.payload.source.connectionId,
          payload: input.payload,
          specHash: input.specHash,
          idempotencyKey: input.idempotencyKey,
          expiresAt: input.expiresAt,
        });
        rows.set(key, offer);
        return ok({ outcome: 'created', offer });
      },
      replacePendingPayload: async (input) => {
        const entry = [...rows.entries()].find(([, row]) => row.id === input.offerId);
        if (!entry) return ok({ outcome: 'stale' });
        const [key, row] = entry;
        if (row.status !== 'pending' || row.specHash !== input.expectedSpecHash) {
          return ok({ outcome: 'stale' });
        }
        const updated = { ...row, payload: input.payload, specHash: input.specHash };
        rows.set(key, updated);
        return ok({ outcome: 'replaced', offer: updated });
      },
      cancelPending: async (input) => {
        const entry = [...rows.entries()].find(([, row]) => row.id === input.offerId);
        if (!entry || entry[1].status !== 'pending') return ok(false);
        rows.set(entry[0], { ...entry[1], status: 'cancelled' });
        return ok(true);
      },
      loadForConfirmation: async () => ok({ outcome: 'not_found' }),
      claimConfirmation: async () => ok({ outcome: 'not_found' }),
      markConfirmed: async () => ok(true),
    };
    return repo;
  };

  const serviceWith = (offers: DataExportOfferRepositoryPort) => new DataExportOfferService({
    ...confirmationDeps,
    offers,
    queue: { enqueue: async () => assert.fail('appending must not queue anything') },
    now: () => NOW,
  });

  it('folds one call per domain into a single offer covering every row', async () => {
    const offers = fakeRepo();
    const service = serviceWith(offers);
    const domains = Array.from({ length: 22 }, (_, index) => `site-${index}.com`);

    const results = [];
    for (const domain of domains) {
      results.push(await service.appendAuthorizedPart(semrushPayload(domain), {
        observedRowCount: 1,
      }));
    }

    const offerIds = new Set(results.map(result =>
      result.outcome === 'appended' ? result.offerId : 'withdrawn'));
    assert.deepEqual(offerIds, new Set(['offer-1']), 'every call feeds one offer');
    const stored = [...offers.rows.values()][0]!;
    assert.equal(stored.payload.additionalParts?.length, 21);
    assert.equal(stored.payload.observedRowCount, 22, 'the offer counts all 22 rows');
    assert.deepEqual(
      [stored.payload.source, ...(stored.payload.additionalParts ?? [])]
        .map(source => source.kind === 'semrush_snapshot' && 'domain' in source.args
          ? source.args.domain
          : null),
      domains,
      'parts keep the order the run produced them',
    );
  });

  it('withdraws the offer rather than exporting one shape out of two', async () => {
    const offers = fakeRepo();
    const service = serviceWith(offers);
    await service.appendAuthorizedPart(semrushPayload('site-a.com'), { observedRowCount: 1 });

    const mixed = await service.appendAuthorizedPart({
      ...payload,
      source: {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'domain_overview', domain: 'site-a.com' },
      },
      destination: { format: 'auto', title: 'Domain overviews' },
    }, { observedRowCount: 100 });

    assert.deepEqual(mixed, {
      outcome: 'withdrawn',
      reason: 'shape_mismatch',
      revokedOfferId: 'offer-1',
    });
    assert.equal(
      [...offers.rows.values()][0]!.status,
      'cancelled',
      'the already-offered button must not survive a shape it cannot represent',
    );
  });

  it('does not double-count a provider call that was retried', async () => {
    const offers = fakeRepo();
    const service = serviceWith(offers);
    await service.appendAuthorizedPart(semrushPayload('site-a.com'), { observedRowCount: 1 });
    const repeated = await service.appendAuthorizedPart(semrushPayload('site-a.com'), {
      observedRowCount: 1,
    });

    assert.equal(repeated.outcome, 'appended');
    const stored = [...offers.rows.values()][0]!;
    assert.equal(stored.payload.additionalParts, undefined);
    assert.equal(stored.payload.observedRowCount, 1);
  });
});

describe('Export identity separates the dataset from the artifact', () => {
  const withFormat = (format: DataExportJobPayload['destination']['format']) => ({
    ...payload,
    destination: { ...payload.destination, format },
  });

  it('gives each offered format its own job so the second button is a real file', () => {
    assert.notEqual(
      dataExportJobId(withFormat('google_sheet')),
      dataExportJobId(withFormat('xlsx')),
    );
    assert.notEqual(
      dataExportJobId(withFormat('csv')),
      dataExportJobId(withFormat('xlsx')),
    );
  });

  it('keeps one dataset identity across formats so a run\'s parts still merge', () => {
    assert.equal(
      dataExportOfferKey(withFormat('google_sheet')),
      dataExportOfferKey(withFormat('xlsx')),
    );
    assert.notEqual(
      dataExportOfferKey(payload),
      dataExportOfferKey({ ...payload, requestId: 'request-2' }),
    );
  });
});

describe('Taking more than one format from one offer', () => {
  /**
   * A single mutable offer row plus just enough Prisma semantics to evaluate
   * the repository's real `where` clauses. The point is to exercise the
   * predicates themselves — a hand-written fake that ignores them cannot catch
   * a claim rule that lets a confirmed offer re-open when it should not.
   */
  const inMemoryOfferDb = (seed: Record<string, any>) => {
    const state = { ...seed };
    const queued: string[] = [];

    const matches = (where: any): boolean => {
      for (const [key, condition] of Object.entries(where ?? {})) {
        if (key === 'OR') {
          if (!(condition as any[]).some(matches)) return false;
          continue;
        }
        if (key === 'NOT') {
          if (matches(condition)) return false;
          continue;
        }
        const value = state[key];
        if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
          const c = condition as any;
          if ('has' in c && !(value as string[]).includes(c.has)) return false;
          if ('not' in c && value === c.not) return false;
          if ('gt' in c && !(value > c.gt)) return false;
          if ('lte' in c && !(value <= c.lte)) return false;
          continue;
        }
        if (value !== condition) return false;
      }
      return true;
    };

    const apply = (data: any) => {
      for (const [key, value] of Object.entries(data)) {
        if (value !== null && typeof value === 'object' && 'push' in (value as any)) {
          state[key] = [...state[key], (value as any).push];
        } else {
          state[key] = value;
        }
      }
    };

    return {
      state,
      queued,
      db: {
        dataExportOffer: {
          findFirst: async ({ where }: any) => (matches(where) ? { ...state } : null),
          updateMany: async ({ where, data }: any) => {
            if (!matches(where)) return { count: 0 };
            apply(data);
            return { count: 1 };
          },
        },
      } as any,
    };
  };

  const confirmedOfferService = (harness: ReturnType<typeof inMemoryOfferDb>) => {
    const repository = new DataExportOfferRepository(harness.db);
    return new DataExportOfferService({
      ...confirmationDeps,
      offers: repository,
      queue: {
        // Mirrors DataExportQueue: a job id already present is not re-added.
        enqueue: async (job: any) => {
          const jobId = dataExportJobId(job);
          if (harness.queued.includes(jobId)) return { jobId, added: false };
          harness.queued.push(jobId);
          return { jobId, added: true };
        },
      },
      now: () => NOW,
    });
  };

  const click = (service: DataExportOfferService, format: 'google_sheet' | 'csv' | 'xlsx') =>
    service.confirmForActor({
      offerId: 'offer-1',
      companyId: payload.companyId,
      userId: payload.userId,
      chatId: payload.chatId,
      destinationFormat: format,
    });

  const seedRow = () => ({
    id: 'offer-1',
    companyId: payload.companyId,
    userId: payload.userId,
    departmentId: payload.departmentId,
    sourceKind: payload.source.kind,
    sourceConnectionId: payload.source.connectionId,
    payloadJson: payload,
    specHash: dataExportSpecHash(payload),
    idempotencyKey: dataExportOfferKey(payload),
    status: 'pending',
    queueJobId: null,
    confirmedJobIds: [] as string[],
    expiresAt: new Date(NOW.getTime() + DATA_EXPORT_OFFER_TTL_MS),
    confirmedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

  it('gives each format its own file and never reports a queue that did not happen', async () => {
    const harness = inMemoryOfferDb(seedRow());
    const service = confirmedOfferService(harness);

    const sheet = await click(service, 'google_sheet');
    const csv = await click(service, 'csv');
    const sheetAgain = await click(service, 'google_sheet');
    const csvAgain = await click(service, 'csv');

    assert.equal((sheet as any).disposition, 'queued');
    assert.equal((csv as any).disposition, 'queued');
    assert.notEqual((sheet as any).exportJobId, (csv as any).exportJobId);
    // Once two formats exist, `queueJobId` can only remember the newest. A
    // repeat click used to re-claim on that basis and answer "queued" while
    // adding nothing to the queue.
    assert.equal((sheetAgain as any).disposition, 'already_confirmed');
    assert.equal((csvAgain as any).disposition, 'already_confirmed');
    assert.equal((sheetAgain as any).exportJobId, (sheet as any).exportJobId);
    assert.equal(harness.queued.length, 2, 'exactly one job per format');
  });

  it('still opens for a format the member has not taken yet', async () => {
    const harness = inMemoryOfferDb(seedRow());
    const service = confirmedOfferService(harness);

    await click(service, 'google_sheet');
    const xlsx = await click(service, 'xlsx');

    assert.equal((xlsx as any).disposition, 'queued');
    assert.equal(harness.queued.length, 2);
    assert.equal(harness.state.confirmedJobIds.length, 2, 'the ledger records both artifacts');
  });
});

describe('Withdrawal reports only what it actually did', () => {
  const semrushPart = (domain: string): DataExportOfferPayload => ({
    ...payload,
    source: {
      kind: 'semrush_snapshot',
      connectionId: 'backend_managed',
      args: { operation: 'domain_overview', domain },
    },
    destination: { format: 'auto', title: 'Overviews' },
  });

  it('cancels the offer when every append round loses the race', async () => {
    let cancelled = false;
    const offer = storedOffer({
      id: 'offer-1',
      status: 'pending',
      payload: semrushPart('a.com'),
      sourceKind: 'semrush_snapshot',
      sourceConnectionId: 'backend_managed',
    });
    const service = new DataExportOfferService({
      ...confirmationDeps,
      offers: {
        create: async () => ok({ outcome: 'existing', offer }),
        // Always stale: a concurrent append wins every round.
        replacePendingPayload: async () => ok({ outcome: 'stale' }),
        cancelPending: async () => { cancelled = true; return ok(true); },
        loadForConfirmation: async () => ok({ outcome: 'not_found' }),
        claimConfirmation: async () => ok({ outcome: 'not_found' }),
        markConfirmed: async () => ok(true),
      },
      queue: { enqueue: async () => assert.fail('appending must not queue') },
      now: () => NOW,
    });

    const result = await service.appendAuthorizedPart(semrushPart('z.com'), {
      observedRowCount: 1,
    });

    assert.deepEqual(result, {
      outcome: 'withdrawn',
      reason: 'append_contention',
      revokedOfferId: 'offer-1',
    });
    assert.equal(cancelled, true, 'a part that never landed must not leave a live button');
  });

  it('does not report a revocation it did not perform', async () => {
    // The offer is already cancelled, so cancelPending matches nothing.
    const offer = storedOffer({ id: 'offer-1', status: 'cancelled' });
    const service = new DataExportOfferService({
      ...confirmationDeps,
      offers: {
        create: async () => ok({ outcome: 'existing', offer }),
        replacePendingPayload: async () => ok({ outcome: 'stale' }),
        cancelPending: async () => ok(false),
        loadForConfirmation: async () => ok({ outcome: 'not_found' }),
        claimConfirmation: async () => ok({ outcome: 'not_found' }),
        markConfirmed: async () => ok(true),
      },
      queue: { enqueue: async () => assert.fail('appending must not queue') },
      now: () => NOW,
    });

    const result = await service.appendAuthorizedPart(semrushPart('b.com'), {
      observedRowCount: 1,
    });

    assert.deepEqual(result, { outcome: 'withdrawn', reason: 'offer_not_appendable' });
  });
});

describe('Row shape decides what may share one export', () => {
  const airtable = (fieldIds: string[] | undefined, tableId = 'tbl1') => ({
    kind: 'airtable_records' as const,
    connectionId: '11111111-1111-4111-8111-111111111111',
    toolId: 'airtableRecords' as const,
    nativeTool: 'list_records_for_table' as const,
    input: { baseId: 'app1', tableId, ...(fieldIds ? { fieldIds } : {}) },
  });

  it('separates reads of one table that select different columns', () => {
    assert.notEqual(
      datasetSourceShapeKey(airtable(['fldA', 'fldB'])),
      datasetSourceShapeKey(airtable(['fldA'])),
    );
    // Order is not meaning: the same fields chosen in another order are one shape.
    assert.equal(
      datasetSourceShapeKey(airtable(['fldB', 'fldA'])),
      datasetSourceShapeKey(airtable(['fldA', 'fldB'])),
    );
  });

  it('separates the same module read through different connections', () => {
    const invoices = (connectionId: string) => ({
      kind: 'zoho_books' as const,
      connectionId,
      module: 'invoices' as const,
    });
    assert.notEqual(
      datasetSourceShapeKey(invoices('11111111-1111-4111-8111-111111111111')),
      datasetSourceShapeKey(invoices('22222222-2222-4222-8222-222222222222')),
    );
  });

  it('keeps one Semrush operation across domains as a single shape', () => {
    const overview = (domain: string) => ({
      kind: 'semrush_snapshot' as const,
      connectionId: 'backend_managed' as const,
      args: { operation: 'domain_overview' as const, domain },
    });
    assert.equal(datasetSourceShapeKey(overview('a.com')), datasetSourceShapeKey(overview('b.com')));
  });
});
