import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RunEffectReceiptStore } from '../../src/application/runtime/run-effect-receipt.store.ts';
import { ok, err } from '../../src/shared/result.ts';

const identity = {
  companyId: 'company-1',
  userId: 'user-1',
  chatId: 'chat-1',
  threadId: 'thread-1',
  runId: 'run-1',
};

describe('run effect receipt store', () => {
  it('binds one opened review to the exact backend-issued run identity', async () => {
    const fixture = createStore();
    assert.deepEqual(
      await fixture.store.reserveKnowledgeReview(identity, {
        requestId: 'proposal-1',
        effectKind: 'memory_review_opened',
      }),
      { status: 'claimed' },
    );
    const opened = await fixture.store.completeKnowledgeReview({
      identity,
      requestId: 'proposal-1',
      reviewId: 'review-1',
      cardMessageId: 'om_card_1',
      message: 'Review opened',
    });

    assert.equal(opened.status, 'opened');
    assert.equal((await fixture.store.getOpenedKnowledgeReview(identity))?.reviewId, 'review-1');
  });

  it('allows multiple exact review requests in one run without cross-request reuse', async () => {
    const fixture = createStore();
    await fixture.store.reserveKnowledgeReview(identity, {
      requestId: 'proposal-1',
      effectKind: 'memory_review_opened',
    });
    await fixture.store.completeKnowledgeReview({
      identity,
      requestId: 'proposal-1',
      reviewId: 'review-1',
      cardMessageId: 'om_card_1',
      message: 'Review opened',
    });

    assert.deepEqual(await fixture.store.reserveKnowledgeReview(identity, {
      requestId: 'proposal-2',
      effectKind: 'memory_review_opened',
    }), { status: 'claimed' });
    await fixture.store.completeKnowledgeReview({
      identity,
      requestId: 'proposal-2',
      reviewId: 'review-2',
      cardMessageId: 'om_card_2',
      message: 'Second review opened',
    });
    assert.equal((await fixture.store.getOpenedKnowledgeReview(identity))?.reviewId, 'review-2');
  });

  it('keeps a concurrent reservation in opening state', async () => {
    const fixture = createStore();
    await fixture.store.reserveKnowledgeReview(identity, {
      requestId: 'proposal-1',
      effectKind: 'memory_review_opened',
    });
    assert.deepEqual(
      await fixture.store.reserveKnowledgeReview(identity, {
        requestId: 'proposal-1',
        effectKind: 'memory_review_opened',
      }),
      { status: 'opening' },
    );
  });

  it('does not expose a receipt under another run, user, company, chat, or thread', async () => {
    const fixture = createStore();
    await fixture.store.reserveKnowledgeReview(identity, {
      requestId: 'proposal-1',
      effectKind: 'memory_review_opened',
    });
    await fixture.store.completeKnowledgeReview({
      identity,
      requestId: 'proposal-1',
      reviewId: 'review-1',
      cardMessageId: 'om_card_1',
      message: 'Review opened',
    });

    for (const changed of [
      { ...identity, runId: 'run-2' },
      { ...identity, userId: 'user-2' },
      { ...identity, companyId: 'company-2' },
      { ...identity, chatId: 'chat-2' },
      { ...identity, threadId: 'thread-2' },
    ]) {
      assert.equal(await fixture.store.getOpenedKnowledgeReview(changed), null);
    }
  });

  it('requires the same proposal that owns the reservation', async () => {
    const fixture = createStore();
    await fixture.store.reserveKnowledgeReview(identity, {
      requestId: 'proposal-1',
      effectKind: 'memory_review_opened',
    });
    await assert.rejects(
      fixture.store.completeKnowledgeReview({
        identity,
        requestId: 'proposal-2',
        reviewId: 'review-2',
        cardMessageId: 'om_card_2',
        message: 'Review opened',
      }),
      /no longer matches/i,
    );
  });

  it('attests a personal-memory result only to the exact run identity', async () => {
    const fixture = createStore();
    const effect = await fixture.store.recordPersonalMemory(identity, {
      actionId: 'memory-call-1',
      action: 'updated',
      logicalKey: 'communication.answers.detail',
      resourceId: '11111111-1111-4111-8111-111111111111',
      resourceVersion: 3,
      projection: 'completed',
    });

    assert.equal(effect.effectKind, 'personal_memory_applied');
    assert.deepEqual(await fixture.store.getVerifiedMemoryEffect(identity), effect);
    assert.deepEqual(await fixture.store.getVerifiedKnowledgeEffect(identity), effect);
    assert.equal(
      await fixture.store.getVerifiedMemoryEffect({ ...identity, userId: 'user-2' }),
      null,
    );
  });

  it('attests one export offer to the exact run and rejects ambiguity', async () => {
    const fixture = createStore();
    const offerId = '11111111-1111-4111-8111-111111111111';
    const effect = await fixture.store.recordDataExportOffer(identity, { offerId });

    assert.deepEqual(await fixture.store.recordDataExportOffer(identity, { offerId }), effect);
    assert.deepEqual(await fixture.store.getVerifiedDataExportOffer(identity), effect);
    assert.equal(
      await fixture.store.getVerifiedDataExportOffer({ ...identity, chatId: 'chat-2' }),
      null,
    );
    await assert.rejects(
      fixture.store.recordDataExportOffer(identity, {
        offerId: '22222222-2222-4222-8222-222222222222',
      }),
      /different data export offer/i,
    );
  });

  it('seals a Google Sheet destination to one opaque reference and exact run identity', async () => {
    const fixture = createStore();
    const referenceId = '33333333-3333-4333-8333-333333333333';
    const effect = await fixture.store.recordGoogleSheetDestination(identity, {
      referenceId,
      connectionId: '11111111-1111-4111-8111-111111111111',
      spreadsheetId: 'sheet_1',
      gid: '42',
    });

    assert.deepEqual(
      await fixture.store.getVerifiedGoogleSheetDestination(identity, referenceId),
      effect,
    );
    assert.equal(
      await fixture.store.getVerifiedGoogleSheetDestination(
        { ...identity, threadId: 'thread-2' },
        referenceId,
      ),
      null,
    );
    await assert.rejects(
      fixture.store.recordGoogleSheetDestination(identity, {
        referenceId,
        connectionId: '22222222-2222-4222-8222-222222222222',
        spreadsheetId: 'sheet_2',
      }),
      /different Google Sheet destination/i,
    );
  });

  it('binds one workbook conversion offer to the exact run and card actor', async () => {
    const fixture = createStore();
    const effect = await fixture.store.recordWorkbookConversionOffer(identity, {
      offerId: '44444444-4444-4444-8444-444444444444',
      connectionId: '11111111-1111-4111-8111-111111111111',
      fileId: 'xlsx_file_1',
      fileName: 'Forecast.xlsx',
    });

    assert.deepEqual(await fixture.store.getVerifiedWorkbookConversionOffer(identity), effect);
    assert.deepEqual(await fixture.store.getWorkbookConversionOfferForActor({
      offerId: effect.offerId,
      companyId: identity.companyId,
      userId: identity.userId,
      chatId: identity.chatId,
    }), effect);
    assert.equal(await fixture.store.getWorkbookConversionOfferForActor({
      offerId: effect.offerId,
      companyId: identity.companyId,
      userId: 'other-user',
      chatId: identity.chatId,
    }), null);
  });

  it('recovers an exact personal-memory receipt after the latest index write fails', async () => {
    const fixture = createStore({ failLatestIndexOnce: true });
    const input = {
      actionId: 'memory-call-retry',
      action: 'deleted' as const,
      logicalKey: 'communication.answers.detail',
      resourceId: '11111111-1111-4111-8111-111111111111',
      resourceVersion: 3,
      projection: 'queued' as const,
      requestHash: 'request-hash-1',
    };

    await assert.rejects(fixture.store.recordPersonalMemory(identity, input), /latest index unavailable/i);
    const recovered = await fixture.store.recordPersonalMemory(identity, input);

    assert.equal(recovered.action, 'deleted');
    assert.equal(await fixture.store.getPersonalMemory(identity, input.actionId) !== null, true);
    assert.deepEqual(await fixture.store.getVerifiedMemoryEffect(identity), recovered);
  });

  it('does not let one action ID attest a different personal-memory command', async () => {
    const fixture = createStore();
    await fixture.store.recordPersonalMemory(identity, {
      actionId: 'memory-call-bound',
      action: 'updated',
      logicalKey: 'communication.answers.detail',
      resourceId: '11111111-1111-4111-8111-111111111111',
      resourceVersion: 3,
      projection: 'queued',
      requestHash: 'request-hash-a',
    });

    await assert.rejects(
      fixture.store.recordPersonalMemory(identity, {
        actionId: 'memory-call-bound',
        action: 'deleted',
        logicalKey: 'communication.answers.detail',
        resourceId: '11111111-1111-4111-8111-111111111111',
        resourceVersion: 3,
        projection: 'queued',
        requestHash: 'request-hash-b',
      }),
      /different personal-memory command/i,
    );
  });

  it('atomically fences concurrent personal-memory commands by action ID and hash', async () => {
    const fixture = createStore();
    const claimed = await fixture.store.reservePersonalMemory(identity, {
      actionId: 'memory-call-race',
      requestHash: 'request-hash-a',
    });
    assert.equal(claimed.status, 'claimed');
    const applying = await fixture.store.reservePersonalMemory(identity, {
      actionId: 'memory-call-race',
      requestHash: 'request-hash-a',
    });
    assert.equal(applying.status, 'applying');
    assert.equal(applying.reservationToken, claimed.reservationToken);
    await assert.rejects(
      fixture.store.reservePersonalMemory(identity, {
        actionId: 'memory-call-race',
        requestHash: 'request-hash-b',
      }),
      /different personal-memory command/i,
    );

    await fixture.store.releasePersonalMemory(identity, {
      actionId: 'memory-call-race',
      requestHash: 'request-hash-a',
      reservationToken: 'stale-worker-token',
    });
    const stillApplying = await fixture.store.reservePersonalMemory(identity, {
      actionId: 'memory-call-race',
      requestHash: 'request-hash-a',
    });
    assert.equal(stillApplying.status, 'applying');
    assert.equal(stillApplying.reservationToken, claimed.reservationToken);

    await fixture.store.releasePersonalMemory(identity, {
      actionId: 'memory-call-race',
      requestHash: 'request-hash-a',
      reservationToken: claimed.reservationToken,
    });
    assert.equal((await fixture.store.reservePersonalMemory(identity, {
      actionId: 'memory-call-race',
      requestHash: 'request-hash-a',
    })).status, 'claimed');
  });
});

function createStore(options: { failLatestIndexOnce?: boolean } = {}) {
  const values = new Map<string, unknown>();
  let failLatestIndexOnce = options.failLatestIndexOnce ?? false;
  const cache = {
    get: async <T>(key: string) => ok((values.get(key) as T | undefined) ?? null),
    set: async (key: string, value: unknown) => {
      if (failLatestIndexOnce && key.includes('latest:personal_memory_applied')) {
        failLatestIndexOnce = false;
        return err(new Error('latest index unavailable'));
      }
      values.set(key, value);
      return ok(undefined);
    },
    setNx: async (key: string, value: unknown) => {
      if (values.has(key)) return ok(false);
      values.set(key, value);
      return ok(true);
    },
    del: async (key: string) => {
      values.delete(key);
      return ok(undefined);
    },
    scanDel: async () => ok(0),
  };
  return {
    store: new RunEffectReceiptStore(cache),
    values,
  };
}
