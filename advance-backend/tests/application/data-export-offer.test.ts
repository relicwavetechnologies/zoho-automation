import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DataExportOfferService } from '../../src/application/data-export/data-export-offer.service.ts';
import {
  DATA_EXPORT_OFFER_TTL_MS,
  type DataExportOfferPayload,
  type DataExportOfferRecord,
  type DataExportOfferRepositoryPort,
} from '../../src/application/data-export/export-offer.ts';
import type { DataExportJobPayload } from '../../src/application/data-export/data-export.types.ts';
import { DataExportOfferRepository } from '../../src/infrastructure/persistence/data-export-offer.repository.ts';
import { ok } from '../../src/shared/result.ts';
import { asToolId } from '../../src/shared/ids.ts';
import {
  dataExportJobId,
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

const unusedLoad: DataExportOfferRepositoryPort['loadForConfirmation'] = async () =>
  ok({ outcome: 'not_found' });

const confirmableOffer = (overrides: Partial<DataExportOfferRecord> = {}): DataExportOfferRecord =>
  storedOffer({
    id: '11111111-1111-4111-8111-111111111111',
    specHash: dataExportSpecHash(payload),
    idempotencyKey: dataExportJobId(payload),
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
          return 'dtx_job';
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
          return 'unexpected';
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
          return 'unexpected';
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
          return 'unexpected';
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
          return 'unexpected';
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
          return 'dtx_confirmed';
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
          return 'dtx_existing_sheet';
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
          return 'unexpected';
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
      idempotencyKey: dataExportJobId(threadedPayload),
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
          return 'unexpected';
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
          return 'dtx_confirmed';
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
      exportJobId: dataExportJobId(payload),
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
            return 'unexpected';
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
