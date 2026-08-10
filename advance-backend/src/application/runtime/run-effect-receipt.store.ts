import { createHash, randomUUID } from 'node:crypto';
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
  /** Stable fingerprint of the exact gateway command that produced this effect. */
  readonly requestHash?: string;
  readonly appliedAt: string;
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

interface PersonalMemoryReservation extends LarkRunEffectIdentity {
  readonly version: 1;
  readonly kind: 'personal_memory_reservation';
  readonly status: 'applying';
  readonly actionId: string;
  readonly requestHash: string;
  readonly reservationToken: string;
  readonly createdAt: string;
}

export type ReservePersonalMemoryResult =
  | { readonly status: 'claimed'; readonly reservationToken: string }
  | { readonly status: 'applying'; readonly reservationToken: string };

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

  async reservePersonalMemory(
    identity: LarkRunEffectIdentity,
    input: { readonly actionId: string; readonly requestHash: string },
  ): Promise<ReservePersonalMemoryResult> {
    const reservation: PersonalMemoryReservation = {
      version: 1,
      kind: 'personal_memory_reservation',
      status: 'applying',
      ...identity,
      ...input,
      reservationToken: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const reserved = await this.cache.setNx(
      personalMemoryReservationKey(identity, input.actionId),
      reservation,
      RUN_EFFECT_TTL_SECONDS,
    );
    if (!reserved.ok) throw reserved.error;
    if (reserved.value) return { status: 'claimed', reservationToken: reservation.reservationToken };

    const existing = await this.readPersonalMemoryReservation(identity, input.actionId);
    if (!existing) throw new Error('Personal-memory reservation disappeared.');
    if (existing.requestHash !== input.requestHash) {
      throw new Error('This action ID is already bound to a different personal-memory command.');
    }
    return { status: 'applying', reservationToken: existing.reservationToken };
  }

  async releasePersonalMemory(
    identity: LarkRunEffectIdentity,
    input: {
      readonly actionId: string;
      readonly requestHash: string;
      readonly reservationToken: string;
    },
  ): Promise<void> {
    const existing = await this.readPersonalMemoryReservation(identity, input.actionId);
    if (!existing) return;
    if (existing.requestHash !== input.requestHash) {
      throw new Error('Personal-memory reservation belongs to a different command.');
    }
    if (existing.reservationToken !== input.reservationToken) return;
    const removed = await this.cache.del(personalMemoryReservationKey(identity, input.actionId));
    if (!removed.ok) throw removed.error;
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

    // The exact action receipt is the recovery anchor. Write it before the
    // latest-result index so a timeout or ambiguous cache failure can be
    // repaired by retrying the same action without re-running the mutation.
    const existing = await this.readPersonalMemoryForAction(identity, effect.actionId);
    if (existing) {
      assertSamePersonalMemoryRequest(existing, effect);
      await this.writePersonalMemoryReceipt(identity, existing);
      return existing;
    }

    const latest = await this.readPersonalMemory(identity);
    if (latest?.actionId === effect.actionId) {
      assertSamePersonalMemoryRequest(latest, effect);
      await this.writePersonalMemoryReceipt(identity, latest);
      return latest;
    }

    const exactStored = await this.cache.set(
      personalMemoryEffectKey(identity, effect.actionId),
      effect,
      RUN_EFFECT_TTL_SECONDS,
    );
    if (!exactStored.ok) throw exactStored.error;
    await this.writePersonalMemoryReceipt(identity, effect);
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

  /**
   * Looks up the receipt for one exact action invocation. The action ID is
   * still checked against the run-bound cache namespace by the key and again
   * inside the value before it is returned.
   */
  async getPersonalMemory(
    identity: LarkRunEffectIdentity,
    actionId: string,
  ): Promise<AppliedPersonalMemoryEffect | null> {
    return this.readPersonalMemoryForAction(identity, actionId);
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
    return validatePersonalMemoryEffect(effect, identity);
  }

  private async readPersonalMemoryForAction(
    identity: LarkRunEffectIdentity,
    actionId: string,
  ): Promise<AppliedPersonalMemoryEffect | null> {
    const result = await this.cache.get<AppliedPersonalMemoryEffect>(
      personalMemoryEffectKey(identity, actionId),
    );
    if (!result.ok) throw result.error;
    if (!result.value) return null;
    const effect = validatePersonalMemoryEffect(result.value, identity);
    if (effect.actionId !== actionId) {
      throw new Error('Personal-memory effect action does not match its receipt key.');
    }
    return effect;
  }

  private async readPersonalMemoryReservation(
    identity: LarkRunEffectIdentity,
    actionId: string,
  ): Promise<PersonalMemoryReservation | null> {
    const result = await this.cache.get<PersonalMemoryReservation>(
      personalMemoryReservationKey(identity, actionId),
    );
    if (!result.ok) throw result.error;
    const reservation = result.value;
    if (!reservation) return null;
    if (
      reservation.version !== 1
      || reservation.kind !== 'personal_memory_reservation'
      || reservation.status !== 'applying'
      || reservation.actionId !== actionId
      || typeof reservation.requestHash !== 'string'
      || reservation.requestHash.length === 0
      || typeof reservation.reservationToken !== 'string'
      || reservation.reservationToken.length === 0
    ) {
      throw new Error('Personal-memory reservation is invalid.');
    }
    assertSameIdentity(reservation, identity);
    return reservation;
  }

  private async writePersonalMemoryReceipt(
    identity: LarkRunEffectIdentity,
    effect: AppliedPersonalMemoryEffect,
  ): Promise<void> {
    const stored = await this.cache.set(
      runEffectIndexKey(identity, effect.effectKind),
      effect,
      RUN_EFFECT_TTL_SECONDS,
    );
    if (!stored.ok) throw stored.error;
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
    | 'workbook_conversion_offered',
): string {
  return `${runEffectPrefix(identity)}latest:${effectKind}`;
}

function personalMemoryEffectKey(identity: LarkRunEffectIdentity, actionId: string): string {
  return `${runEffectPrefix(identity)}personal:${sha256(actionId)}`;
}

function personalMemoryReservationKey(identity: LarkRunEffectIdentity, actionId: string): string {
  return `${runEffectPrefix(identity)}personal-reservation:${sha256(actionId)}`;
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
    | PersonalMemoryReservation
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

function validatePersonalMemoryEffect(
  effect: AppliedPersonalMemoryEffect,
  identity: LarkRunEffectIdentity,
): AppliedPersonalMemoryEffect {
  if (
    effect.version !== 1
    || effect.kind !== 'personal_memory'
    || effect.status !== 'applied'
    || effect.effectKind !== 'personal_memory_applied'
  ) {
    throw new Error('Personal-memory effect is invalid.');
  }
  assertSameIdentity(effect, identity);
  return effect;
}

function assertSamePersonalMemoryRequest(
  existing: AppliedPersonalMemoryEffect,
  requested: AppliedPersonalMemoryEffect,
): void {
  if (
    existing.actionId !== requested.actionId
    || (existing.requestHash !== undefined
      && requested.requestHash !== undefined
      && existing.requestHash !== requested.requestHash)
  ) {
    throw new Error('This action ID is already bound to a different personal-memory command.');
  }
}
