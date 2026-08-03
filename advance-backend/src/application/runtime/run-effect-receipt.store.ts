import { createHash } from 'node:crypto';
import type { CachePort } from '../../shared/cache';

const RUN_EFFECT_TTL_SECONDS = 15 * 60;
const RUN_EFFECT_PREFIX = 'pi:run-effect:v2:';
const WORKBOOK_CONVERSION_PREFIX = 'pi:workbook-conversion:v1:';

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
  /**
   * Rows the backend measured across every contributing call. Refreshed as a
   * run adds parts, so the card can state a number it counted rather than one
   * the model inferred from a 25-row preview.
   */
  readonly observedRowCount?: number;
  readonly createdAt: string;
}

export interface GoogleSheetDestinationEffect extends LarkRunEffectIdentity {
  readonly version: 1;
  readonly kind: 'google_sheet_destination';
  readonly status: 'resolved';
  readonly referenceId: string;
  readonly connectionId: string;
  readonly spreadsheetId: string;
  readonly gid?: string;
  readonly createdAt: string;
}

export interface OfferedWorkbookConversionEffect extends LarkRunEffectIdentity {
  readonly version: 1;
  readonly kind: 'workbook_conversion_offer';
  readonly status: 'offered';
  readonly effectKind: 'workbook_conversion_offered';
  readonly offerId: string;
  readonly connectionId: string;
  readonly fileId: string;
  readonly fileName?: string;
  readonly departmentId?: string;
  readonly replyInThread?: boolean;
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
    input: { readonly offerId: string; readonly observedRowCount?: number },
  ): Promise<OfferedDataExportEffect> {
    if (!isUuid(input.offerId)) throw new Error('Data export offer ID is invalid.');
    const effect: OfferedDataExportEffect = {
      version: 1,
      kind: 'data_export_offer',
      status: 'offered',
      effectKind: 'data_export_offered',
      ...identity,
      offerId: input.offerId,
      ...(input.observedRowCount !== undefined
        ? { observedRowCount: input.observedRowCount }
        : {}),
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
    // Same offer, more parts: refresh the measured count so the card reflects
    // the whole answer rather than whichever call happened to arrive first.
    if (
      input.observedRowCount !== undefined
      && input.observedRowCount !== existing.observedRowCount
    ) {
      const refreshed: OfferedDataExportEffect = {
        ...existing,
        observedRowCount: input.observedRowCount,
      };
      const updated = await this.cache.set(
        runEffectIndexKey(identity, refreshed.effectKind),
        refreshed,
        RUN_EFFECT_TTL_SECONDS,
      );
      if (!updated.ok) throw updated.error;
      return refreshed;
    }
    return existing;
  }

  /**
   * Drop this run's export binding so the final card renders no export action.
   * Used when a run's datasets stop fitting one file — the offer row itself is
   * cancelled separately by the offer service.
   */
  async clearDataExportOffer(identity: LarkRunEffectIdentity): Promise<void> {
    const removed = await this.cache.del(
      runEffectIndexKey(identity, 'data_export_offered'),
    );
    if (!removed.ok) throw removed.error;
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

  async recordWorkbookConversionOffer(
    identity: LarkRunEffectIdentity,
    input: {
      readonly offerId: string;
      readonly connectionId: string;
      readonly fileId: string;
      readonly fileName?: string;
      readonly departmentId?: string;
      readonly replyInThread?: boolean;
    },
  ): Promise<OfferedWorkbookConversionEffect> {
    if (
      !isUuid(input.offerId)
      || !isUuid(input.connectionId)
      || !isSpreadsheetId(input.fileId)
      || (input.departmentId !== undefined && !isUuid(input.departmentId))
    ) {
      throw new Error('Workbook conversion offer is invalid.');
    }
    const effect: OfferedWorkbookConversionEffect = {
      version: 1,
      kind: 'workbook_conversion_offer',
      status: 'offered',
      effectKind: 'workbook_conversion_offered',
      ...identity,
      ...input,
      createdAt: new Date().toISOString(),
    };
    const storedOffer = await this.cache.set(
      workbookConversionKey(input.offerId),
      effect,
      RUN_EFFECT_TTL_SECONDS,
    );
    if (!storedOffer.ok) throw storedOffer.error;
    const storedIndex = await this.cache.setNx(
      runEffectIndexKey(identity, effect.effectKind),
      effect,
      RUN_EFFECT_TTL_SECONDS,
    );
    if (!storedIndex.ok) {
      await this.cache.del(workbookConversionKey(input.offerId));
      throw storedIndex.error;
    }
    if (storedIndex.value) return effect;

    const existing = await this.getVerifiedWorkbookConversionOffer(identity);
    if (!existing) throw new Error('Workbook conversion offer receipt disappeared.');
    if (existing.offerId !== input.offerId) {
      await this.cache.del(workbookConversionKey(input.offerId));
      throw new Error('This run is already bound to a different workbook conversion offer.');
    }
    return existing;
  }

  async getVerifiedWorkbookConversionOffer(
    identity: LarkRunEffectIdentity,
  ): Promise<OfferedWorkbookConversionEffect | null> {
    const result = await this.cache.get<OfferedWorkbookConversionEffect>(
      runEffectIndexKey(identity, 'workbook_conversion_offered'),
    );
    if (!result.ok) throw result.error;
    const effect = result.value;
    if (!effect) return null;
    assertWorkbookConversionEffect(effect);
    assertSameIdentity(effect, identity);
    return effect;
  }

  async getWorkbookConversionOfferForActor(input: {
    readonly offerId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly chatId: string;
  }): Promise<OfferedWorkbookConversionEffect | null> {
    if (!isUuid(input.offerId)) return null;
    const result = await this.cache.get<OfferedWorkbookConversionEffect>(
      workbookConversionKey(input.offerId),
    );
    if (!result.ok) throw result.error;
    const effect = result.value;
    if (!effect) return null;
    assertWorkbookConversionEffect(effect);
    return effect.companyId === input.companyId
      && effect.userId === input.userId
      && effect.chatId === input.chatId
      ? effect
      : null;
  }

  async recordGoogleSheetDestination(
    identity: LarkRunEffectIdentity,
    input: {
      readonly referenceId: string;
      readonly connectionId: string;
      readonly spreadsheetId: string;
      readonly gid?: string;
    },
  ): Promise<GoogleSheetDestinationEffect> {
    if (!isUuid(input.referenceId) || !isUuid(input.connectionId)) {
      throw new Error('Google Sheet destination reference is invalid.');
    }
    if (!isSpreadsheetId(input.spreadsheetId) || !isSheetGid(input.gid)) {
      throw new Error('Google Sheet destination is invalid.');
    }
    const effect: GoogleSheetDestinationEffect = {
      version: 1,
      kind: 'google_sheet_destination',
      status: 'resolved',
      ...identity,
      ...input,
      createdAt: new Date().toISOString(),
    };
    const stored = await this.cache.setNx(
      googleSheetDestinationKey(identity, input.referenceId),
      effect,
      RUN_EFFECT_TTL_SECONDS,
    );
    if (!stored.ok) throw stored.error;
    if (stored.value) return effect;

    const existing = await this.getVerifiedGoogleSheetDestination(identity, input.referenceId);
    if (!existing) throw new Error('Google Sheet destination receipt disappeared.');
    if (
      existing.connectionId !== input.connectionId
      || existing.spreadsheetId !== input.spreadsheetId
      || existing.gid !== input.gid
    ) {
      throw new Error('This reference is already bound to a different Google Sheet destination.');
    }
    return existing;
  }

  async getVerifiedGoogleSheetDestination(
    identity: LarkRunEffectIdentity,
    referenceId: string,
  ): Promise<GoogleSheetDestinationEffect | null> {
    if (!isUuid(referenceId)) throw new Error('Google Sheet destination reference is invalid.');
    const result = await this.cache.get<GoogleSheetDestinationEffect>(
      googleSheetDestinationKey(identity, referenceId),
    );
    if (!result.ok) throw result.error;
    const effect = result.value;
    if (!effect) return null;
    if (
      effect.version !== 1
      || effect.kind !== 'google_sheet_destination'
      || effect.status !== 'resolved'
      || effect.referenceId !== referenceId
      || !isUuid(effect.connectionId)
      || !isSpreadsheetId(effect.spreadsheetId)
      || !isSheetGid(effect.gid)
    ) {
      throw new Error('Google Sheet destination receipt is invalid.');
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

function googleSheetDestinationKey(identity: LarkRunEffectIdentity, referenceId: string): string {
  return `${runEffectPrefix(identity)}google-sheet:${sha256(referenceId)}`;
}

function workbookConversionKey(offerId: string): string {
  return `${WORKBOOK_CONVERSION_PREFIX}${sha256(offerId)}`;
}

function runEffectIndexKey(
  identity: LarkRunEffectIdentity,
  effectKind:
    | KnowledgeReviewEffectKind
    | 'personal_memory_applied'
    | 'data_export_offered'
    | 'workbook_conversion_offered',
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
  effect:
    | KnowledgeReviewRunEffect
    | AppliedPersonalMemoryEffect
    | OfferedDataExportEffect
    | GoogleSheetDestinationEffect
    | OfferedWorkbookConversionEffect,
  identity: LarkRunEffectIdentity,
): void {
  for (const key of ['companyId', 'userId', 'chatId', 'threadId', 'runId'] as const) {
    if (effect[key] !== identity[key]) {
      throw new Error(`Knowledge review effect ${key} does not match this runtime.`);
    }
  }
}

function assertWorkbookConversionEffect(effect: OfferedWorkbookConversionEffect): void {
  if (
    effect.version !== 1
    || effect.kind !== 'workbook_conversion_offer'
    || effect.status !== 'offered'
    || effect.effectKind !== 'workbook_conversion_offered'
    || !isUuid(effect.offerId)
    || !isUuid(effect.connectionId)
    || !isSpreadsheetId(effect.fileId)
    || (effect.departmentId !== undefined && !isUuid(effect.departmentId))
  ) {
    throw new Error('Workbook conversion offer receipt is invalid.');
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSpreadsheetId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function isSheetGid(value: string | undefined): boolean {
  return value === undefined
    || (/^(?:0|[1-9][0-9]{0,19})$/.test(value) && Number.isSafeInteger(Number(value)));
}
