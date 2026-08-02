import { createHash } from 'node:crypto';
import type { CachePort } from '../../shared/cache';

const RUN_EFFECT_TTL_SECONDS = 15 * 60;
const RUN_EFFECT_PREFIX = 'pi:run-effect:v2:';

export interface LarkRunEffectIdentity {
  readonly companyId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly runId: string;
}

export type KnowledgeReviewEffectKind = 'memory_review_opened' | 'knowledge_review_opened';
export type VerifiedKnowledgeEffectKind = KnowledgeReviewEffectKind | 'personal_memory_applied';

interface OpeningKnowledgeReviewEffect extends LarkRunEffectIdentity {
  readonly version: 1;
  readonly kind: 'knowledge_review';
  readonly status: 'opening';
  readonly requestId: string;
  readonly effectKind: KnowledgeReviewEffectKind;
  readonly createdAt: string;
}

export interface OpenedKnowledgeReviewEffect extends LarkRunEffectIdentity {
  readonly version: 1;
  readonly kind: 'knowledge_review';
  readonly status: 'opened';
  readonly requestId: string;
  readonly effectKind: KnowledgeReviewEffectKind;
  readonly reviewId: string;
  readonly cardMessageId: string;
  readonly message: string;
  readonly createdAt: string;
  readonly openedAt: string;
}

type KnowledgeReviewRunEffect = OpeningKnowledgeReviewEffect | OpenedKnowledgeReviewEffect;

export interface AppliedPersonalMemoryEffect extends LarkRunEffectIdentity {
  readonly version: 1;
  readonly kind: 'personal_memory';
  readonly status: 'applied';
  readonly effectKind: 'personal_memory_applied';
  readonly actionId: string;
  readonly action: 'created' | 'updated' | 'unchanged' | 'deleted';
  readonly logicalKey: string;
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly projection: 'completed' | 'queued';
  readonly appliedAt: string;
}

export interface OfferedDataExportEffect extends LarkRunEffectIdentity {
  readonly version: 1;
  readonly kind: 'data_export_offer';
  readonly status: 'offered';
  readonly effectKind: 'data_export_offered';
  readonly offerId: string;
  readonly createdAt: string;
}

export type VerifiedKnowledgeEffect = OpenedKnowledgeReviewEffect | AppliedPersonalMemoryEffect;

export type ReserveKnowledgeReviewEffectResult =
  | { readonly status: 'claimed' }
  | { readonly status: 'opening' }
  | { readonly status: 'opened'; readonly effect: OpenedKnowledgeReviewEffect };

/**
 * Backend-owned, run-scoped evidence for user-visible effects created by Pi.
 *
 * The key is derived from a backend-issued run ID and bound again to the live
 * member/chat/thread identity. Pi can request an effect, but it cannot mint or
 * move this receipt between users, companies, chats, threads, or runs.
 */
export class RunEffectReceiptStore {
  constructor(private readonly cache: CachePort) {}

  async reserveKnowledgeReview(
    identity: LarkRunEffectIdentity,
    input: { readonly requestId: string; readonly effectKind: KnowledgeReviewEffectKind },
  ): Promise<ReserveKnowledgeReviewEffectResult> {
    const opening: OpeningKnowledgeReviewEffect = {
      version: 1,
      kind: 'knowledge_review',
      status: 'opening',
      ...identity,
      requestId: input.requestId,
      effectKind: input.effectKind,
      createdAt: new Date().toISOString(),
    };
    const reserved = await this.cache.setNx(
      runEffectKey(identity, input.requestId),
      opening,
      RUN_EFFECT_TTL_SECONDS,
    );
    if (!reserved.ok) throw reserved.error;
    if (reserved.value) return { status: 'claimed' };

    const existing = await this.read(identity, input.requestId);
    if (!existing) {
      throw new Error('Knowledge review effect reservation disappeared.');
    }
    if (existing.effectKind !== input.effectKind) {
      throw new Error('This request is already bound to a different knowledge review kind.');
    }
    if (existing.status === 'opened') return { status: 'opened', effect: existing };
    return { status: 'opening' };
  }

  async completeKnowledgeReview(input: {
    identity: LarkRunEffectIdentity;
    requestId: string;
    reviewId: string;
    cardMessageId: string;
    message: string;
  }): Promise<OpenedKnowledgeReviewEffect> {
    const current = await this.read(input.identity, input.requestId);
    if (
      !current
      || current.status !== 'opening'
      || current.requestId !== input.requestId
    ) {
      throw new Error('Knowledge review effect reservation no longer matches this run.');
    }
    const opened: OpenedKnowledgeReviewEffect = {
      ...current,
      status: 'opened',
      reviewId: input.reviewId,
      cardMessageId: input.cardMessageId,
      message: input.message,
      openedAt: new Date().toISOString(),
    };
    const stored = await this.cache.set(
      runEffectKey(input.identity, input.requestId),
      opened,
      RUN_EFFECT_TTL_SECONDS,
    );
    if (!stored.ok) throw stored.error;
    const indexed = await this.cache.set(
      runEffectIndexKey(input.identity, opened.effectKind),
      opened,
      RUN_EFFECT_TTL_SECONDS,
    );
    if (!indexed.ok) throw indexed.error;
    return opened;
  }

  async releaseKnowledgeReview(identity: LarkRunEffectIdentity, requestId: string): Promise<void> {
    const current = await this.read(identity, requestId);
    const removed = await this.cache.del(runEffectKey(identity, requestId));
    if (!removed.ok) throw removed.error;
    if (current) {
      const indexed = await this.readIndex(identity, current.effectKind);
      if (indexed?.requestId === requestId) {
        const indexRemoved = await this.cache.del(runEffectIndexKey(identity, current.effectKind));
        if (!indexRemoved.ok) throw indexRemoved.error;
      }
    }
  }

  async getOpenedKnowledgeReview(
    identity: LarkRunEffectIdentity,
  ): Promise<OpenedKnowledgeReviewEffect | null> {
    // Memory evidence wins because the result guard needs a verified receipt
    // before allowing any “saved to memory” completion claim. Generic
    // procedure/file reviews are still available when no memory card opened.
    return await this.readIndex(identity, 'memory_review_opened')
      ?? await this.readIndex(identity, 'knowledge_review_opened');
  }

  async recordPersonalMemory(
    identity: LarkRunEffectIdentity,
    input: Omit<
      AppliedPersonalMemoryEffect,
      keyof LarkRunEffectIdentity | 'version' | 'kind' | 'status' | 'effectKind' | 'appliedAt'
    >,
  ): Promise<AppliedPersonalMemoryEffect> {
    const effect: AppliedPersonalMemoryEffect = {
      version: 1,
      kind: 'personal_memory',
      status: 'applied',
      effectKind: 'personal_memory_applied',
      ...identity,
      ...input,
      appliedAt: new Date().toISOString(),
    };
    const stored = await this.cache.set(
      runEffectIndexKey(identity, effect.effectKind),
      effect,
      RUN_EFFECT_TTL_SECONDS,
    );
    if (!stored.ok) throw stored.error;
    return effect;
  }

  async recordDataExportOffer(
    identity: LarkRunEffectIdentity,
    input: { readonly offerId: string },
  ): Promise<OfferedDataExportEffect> {
    if (!isUuid(input.offerId)) throw new Error('Data export offer ID is invalid.');
    const effect: OfferedDataExportEffect = {
      version: 1,
      kind: 'data_export_offer',
      status: 'offered',
      effectKind: 'data_export_offered',
      ...identity,
      offerId: input.offerId,
      createdAt: new Date().toISOString(),
    };
    const stored = await this.cache.setNx(
      runEffectIndexKey(identity, effect.effectKind),
      effect,
      RUN_EFFECT_TTL_SECONDS,
    );
    if (!stored.ok) throw stored.error;
    if (stored.value) return effect;

    const existing = await this.getVerifiedDataExportOffer(identity);
    if (!existing) throw new Error('Data export offer receipt disappeared.');
    if (existing.offerId !== input.offerId) {
      throw new Error('This run is already bound to a different data export offer.');
    }
    return existing;
  }

  async getVerifiedDataExportOffer(
    identity: LarkRunEffectIdentity,
  ): Promise<OfferedDataExportEffect | null> {
    const result = await this.cache.get<OfferedDataExportEffect>(
      runEffectIndexKey(identity, 'data_export_offered'),
    );
    if (!result.ok) throw result.error;
    const effect = result.value;
    if (!effect) return null;
    if (
      effect.version !== 1
      || effect.kind !== 'data_export_offer'
      || effect.status !== 'offered'
      || effect.effectKind !== 'data_export_offered'
      || !isUuid(effect.offerId)
    ) {
      throw new Error('Data export offer effect index is invalid.');
    }
    assertSameIdentity(effect, identity);
    return effect;
  }

  async getVerifiedMemoryEffect(
    identity: LarkRunEffectIdentity,
  ): Promise<VerifiedKnowledgeEffect | null> {
    return await this.readPersonalMemory(identity)
      ?? await this.readIndex(identity, 'memory_review_opened');
  }

  async getVerifiedKnowledgeEffect(
    identity: LarkRunEffectIdentity,
  ): Promise<VerifiedKnowledgeEffect | null> {
    return await this.readPersonalMemory(identity)
      ?? await this.getOpenedKnowledgeReview(identity);
  }

  private async read(
    identity: LarkRunEffectIdentity,
    requestId: string,
  ): Promise<KnowledgeReviewRunEffect | null> {
    const result = await this.cache.get<KnowledgeReviewRunEffect>(runEffectKey(identity, requestId));
    if (!result.ok) throw result.error;
    const effect = result.value;
    if (!effect) return null;
    if (effect.version !== 1 || effect.kind !== 'knowledge_review') {
      throw new Error('Knowledge review effect reservation is invalid.');
    }
    assertSameIdentity(effect, identity);
    return effect;
  }

  private async readIndex(
    identity: LarkRunEffectIdentity,
    effectKind: KnowledgeReviewEffectKind,
  ): Promise<OpenedKnowledgeReviewEffect | null> {
    const result = await this.cache.get<OpenedKnowledgeReviewEffect>(
      runEffectIndexKey(identity, effectKind),
    );
    if (!result.ok) throw result.error;
    const effect = result.value;
    if (!effect) return null;
    if (
      effect.version !== 1
      || effect.kind !== 'knowledge_review'
      || effect.status !== 'opened'
      || effect.effectKind !== effectKind
    ) {
      throw new Error('Knowledge review effect index is invalid.');
    }
    assertSameIdentity(effect, identity);
    return effect;
  }

  private async readPersonalMemory(
    identity: LarkRunEffectIdentity,
  ): Promise<AppliedPersonalMemoryEffect | null> {
    const result = await this.cache.get<AppliedPersonalMemoryEffect>(
      runEffectIndexKey(identity, 'personal_memory_applied'),
    );
    if (!result.ok) throw result.error;
    const effect = result.value;
    if (!effect) return null;
    if (
      effect.version !== 1
      || effect.kind !== 'personal_memory'
      || effect.status !== 'applied'
      || effect.effectKind !== 'personal_memory_applied'
    ) {
      throw new Error('Personal-memory effect index is invalid.');
    }
    assertSameIdentity(effect, identity);
    return effect;
  }
}

function runEffectKey(identity: LarkRunEffectIdentity, requestId: string): string {
  return `${runEffectPrefix(identity)}request:${sha256(requestId)}`;
}

function runEffectIndexKey(
  identity: LarkRunEffectIdentity,
  effectKind: KnowledgeReviewEffectKind | 'personal_memory_applied' | 'data_export_offered',
): string {
  return `${runEffectPrefix(identity)}latest:${effectKind}`;
}

function runEffectPrefix(identity: LarkRunEffectIdentity): string {
  const digest = createHash('sha256')
    .update([
      identity.companyId,
      identity.userId,
      identity.chatId,
      identity.threadId,
      identity.runId,
    ].join('\u001f'))
    .digest('base64url');
  return `${RUN_EFFECT_PREFIX}${digest}:`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function assertSameIdentity(
  effect: KnowledgeReviewRunEffect | AppliedPersonalMemoryEffect | OfferedDataExportEffect,
  identity: LarkRunEffectIdentity,
): void {
  for (const key of ['companyId', 'userId', 'chatId', 'threadId', 'runId'] as const) {
    if (effect[key] !== identity[key]) {
      throw new Error(`Knowledge review effect ${key} does not match this runtime.`);
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
