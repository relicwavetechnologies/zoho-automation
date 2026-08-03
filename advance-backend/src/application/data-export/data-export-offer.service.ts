import type { DataExportQueue } from './data-export.queue';
import type { PermissionService } from '../permissions/permission.service';
import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import {
  asCompanyId,
  asDepartmentId,
  asToolId,
  asUserId,
} from '../../shared/ids';
import {
  dataExportJobId,
  dataExportOfferKey,
  dataExportSpecHash,
} from './data-export.queue';
import {
  DATA_EXPORT_OFFER_TTL_MS,
  type DataExportOfferPayload,
  type DataExportOfferRecord,
  type DataExportOfferRepositoryPort,
} from './export-offer';
import {
  dataExportParts,
  datasetSourceShapeKey,
  datasetSourceToolId,
} from './data-export.types';
import type { DataExportDestinationTarget } from './data-export.types';
import { DATA_EXPORT_MAX_PARTS } from './data-export-limits';
import { sha256CanonicalJson } from '../../shared/hash';
import type {
  DataExportDestinationChoice,
  ResolveDataExportDestination,
} from './data-export-destination-resolver';

const CONFLICT_MESSAGE =
  'Only one data export can be queued per user request. Ask the user to choose one dataset before exporting.';

/** Bounded because every retry means a concurrent append already succeeded. */
const APPEND_RETRY_LIMIT = 8;

export type AppendDataExportPartWithdrawal =
  | 'shape_mismatch'
  | 'too_many_parts'
  | 'offer_not_appendable'
  | 'append_contention';

export type AppendDataExportPartResult =
  | {
      readonly outcome: 'appended';
      readonly offerId: string;
      readonly expiresAt: Date;
      readonly partCount: number;
      /** Rows measured across every part so far — never a model estimate. */
      readonly observedRowCount: number;
    }
  | {
      readonly outcome: 'withdrawn';
      readonly reason: AppendDataExportPartWithdrawal;
      /** Present when a previously offered export was cancelled by this call. */
      readonly revokedOfferId?: string;
    };

export class DataExportOfferService {
  constructor(private readonly deps: {
    readonly offers: DataExportOfferRepositoryPort;
    readonly queue: Pick<DataExportQueue, 'enqueue'>;
    readonly identityRepo: Pick<ChannelIdentityRepoPort, 'resolveByUserId'>;
    readonly permissions: Pick<PermissionService, 'resolve'>;
    readonly resolveDestination: ResolveDataExportDestination;
    readonly rememberDestination?: (input: {
      readonly companyId: string;
      readonly userId: string;
      readonly connectionId: string;
    }) => Promise<void>;
    readonly now?: () => Date;
  }) {}

  /**
   * Persist and submit an export after the gateway has authorized this exact
   * payload. Opaque-offer confirmation uses confirmForActor instead.
   */
  async submitAuthorized(
    payload: DataExportOfferPayload,
    destinationConnectionId?: string,
  ): Promise<string> {
    const target = await this.requireDestination({
      companyId: payload.companyId,
      userId: payload.userId,
      ...(destinationConnectionId ? { connectionId: destinationConnectionId } : {}),
    });
    const prepared = await this.persistAuthorized(payload);
    const queued = await this.claimAndQueue(prepared.offer, prepared.now, { target });
    return queued.exportJobId;
  }

  async confirmForActor(input: {
    readonly offerId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly progressMessageId?: string;
    readonly destinationFormat?: 'google_sheet' | 'csv' | 'xlsx';
    readonly destinationConnectionId?: string;
    readonly destinationTarget?: DataExportDestinationTarget;
    readonly rememberExplicitPersonalDestination?: boolean;
  }): Promise<
    | {
        readonly exportJobId: string;
        readonly disposition: 'queued' | 'already_confirmed' | 'in_progress';
      }
    | {
        readonly disposition: 'choose_destination';
        readonly connections: readonly DataExportDestinationChoice[];
      }
    | {
        readonly disposition: 'connect_required';
        readonly replyInThread: boolean;
        readonly replyToMessageId?: string;
      }
  > {
    const now = this.deps.now?.() ?? new Date();
    const loaded = await this.deps.offers.loadForConfirmation({
      offerId: input.offerId,
      companyId: input.companyId,
      userId: input.userId,
      now,
    });
    if (!loaded.ok) throw loaded.error;
    if (loaded.value.outcome === 'expired') {
      throw new Error('This data export offer has expired. Ask Divo to prepare it again.');
    }
    if (loaded.value.outcome === 'not_found') {
      throw new Error('This data export offer is no longer available.');
    }
    const offer = loaded.value.offer;
    if (offer.payload.chatId !== input.chatId) {
      throw new Error('Confirm this data export in the same Divo conversation where it was offered.');
    }
    this.assertSameRequest(
      offer,
      offer.payload,
      dataExportSpecHash(offer.payload),
      dataExportOfferKey(offer.payload),
    );

    const identity = await this.deps.identityRepo.resolveByUserId(input.userId, input.companyId);
    if (!identity.ok) throw identity.error;
    if (!identity.value) throw new Error('The export requester no longer has active company access.');
    const permission = await this.deps.permissions.resolve({
      companyId: asCompanyId(input.companyId),
      userId: asUserId(input.userId),
      companyRole: asCompanyRoleSlug(identity.value.aiRole),
      ...(offer.departmentId ? { departmentId: asDepartmentId(offer.departmentId) } : {}),
      channel: 'lark',
    });
    if (!permission.ok) throw permission.error;
    if (!permission.value.allowedActionsByTool.get(asToolId('dataExport'))?.has('create')) {
      throw new Error('Data export permission was revoked before confirmation.');
    }
    const sourceToolId = datasetSourceToolId(offer.payload.source);
    if (!permission.value.allowedActionsByTool.get(asToolId(sourceToolId))?.has('read')) {
      throw new Error(`${sourceToolId} read permission was revoked before confirmation.`);
    }
    if (
      offer.payload.source.kind === 'zoho_books'
      && permission.value.department?.zohoReadScope === 'personalized'
    ) {
      throw new Error('Complete Zoho exports require full company Zoho read scope.');
    }

    const destination = input.destinationTarget
      ? { status: 'selected' as const, target: input.destinationTarget }
      : await this.deps.resolveDestination({
          companyId: input.companyId,
          userId: input.userId,
          ...(input.destinationConnectionId
            ? { connectionId: input.destinationConnectionId }
            : {}),
        });
    if (destination.status === 'choose_connection') {
      return { disposition: 'choose_destination', connections: destination.connections };
    }
    if (destination.status === 'connect_required') {
      return {
        disposition: 'connect_required',
        replyInThread: offer.payload.replyInThread === true,
        ...(offer.payload.replyToMessageId
          ? { replyToMessageId: offer.payload.replyToMessageId }
          : {}),
      };
    }
    if (destination.status === 'unavailable') throw new Error(destination.message);

    const result = await this.claimAndQueue(offer, now, {
      target: destination.target,
      ...(input.progressMessageId
        ? { progressMessageId: input.progressMessageId }
        : {}),
      ...(input.destinationTarget?.kind === 'existing_google_sheet'
        ? { destinationFormat: 'google_sheet' as const }
        : input.destinationFormat
        ? { destinationFormat: input.destinationFormat }
        : {}),
    });
    if (
      result.disposition === 'queued'
      && input.rememberExplicitPersonalDestination === true
      && destination.target.kind === 'user_google'
      && destination.target.connectionId === input.destinationConnectionId
    ) {
      await this.deps.rememberDestination?.({
        companyId: input.companyId,
        userId: input.userId,
        connectionId: destination.target.connectionId,
      });
    }
    return result;
  }

  private async claimAndQueue(
    expected: DataExportOfferRecord,
    now: Date,
    options: {
      readonly target: DataExportDestinationTarget;
      readonly progressMessageId?: string;
      readonly destinationFormat?: 'google_sheet' | 'csv' | 'xlsx';
    },
  ): Promise<{
    readonly exportJobId: string;
    readonly disposition: 'queued' | 'already_confirmed' | 'in_progress';
  }> {
    // The artifact this click is asking for. One offer can legitimately produce
    // a Sheet, a CSV and an Excel file; each is its own job, and only a repeat
    // click on the *same* format is already confirmed.
    const requestedPayload: DataExportOfferPayload = {
      ...expected.payload,
      destination: {
        ...expected.payload.destination,
        ...(options.destinationFormat ? { format: options.destinationFormat } : {}),
      },
    };
    const requestedJobId = dataExportJobId(requestedPayload);
    const claimed = await this.deps.offers.claimConfirmation({
      offerId: expected.id,
      companyId: expected.companyId,
      userId: expected.userId,
      requestedJobId,
      now,
    });
    if (!claimed.ok) throw claimed.error;
    if (claimed.value.outcome === 'already_confirmed') {
      return { exportJobId: claimed.value.queueJobId, disposition: 'already_confirmed' };
    }
    if (claimed.value.outcome === 'in_progress') {
      return { exportJobId: requestedJobId, disposition: 'in_progress' };
    }
    if (claimed.value.outcome === 'expired') {
      throw new Error('This data export offer has expired. Ask Divo to prepare it again.');
    }
    if (claimed.value.outcome === 'not_found') {
      throw new Error('This data export offer is no longer available.');
    }

    this.assertSameRequest(
      claimed.value.offer,
      expected.payload,
      expected.specHash,
      expected.idempotencyKey,
    );
    const claimedPayload = claimed.value.offer.payload;
    const queued = await this.deps.queue.enqueue({
      ...claimedPayload,
      destination: {
        ...claimedPayload.destination,
        ...(options.destinationFormat ? { format: options.destinationFormat } : {}),
        target: options.target,
      },
      ...(options.progressMessageId
        ? { progressMessageId: options.progressMessageId }
        : {}),
    });
    const exportJobId = queued.jobId;
    const confirmed = await this.deps.offers.markConfirmed({
      offerId: claimed.value.offer.id,
      companyId: expected.companyId,
      userId: expected.userId,
      queueJobId: exportJobId,
      confirmedAt: now,
    });
    if (!confirmed.ok) throw confirmed.error;
    if (!confirmed.value) {
      throw new Error('Data export was queued but its confirmation could not be persisted. Retry this request safely.');
    }
    // A job id already present in the queue means this exact artifact is
    // already running or done. Calling that "queued" would promise a card that
    // never arrives.
    return queued.added
      ? { exportJobId, disposition: 'queued' }
      : { exportJobId, disposition: 'already_confirmed' };
  }

  private async requireDestination(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId?: string;
  }): Promise<DataExportDestinationTarget> {
    const destination = await this.deps.resolveDestination(input);
    if (destination.status === 'selected') return destination.target;
    if (destination.status === 'choose_connection') {
      const choices = destination.connections
        .map(choice => `${choice.accountEmail ?? choice.label} (${choice.connectionId})`)
        .join('; ');
      throw new Error(`Choose one Google export account and retry: ${choices}`);
    }
    if (destination.status === 'connect_required') {
      throw new Error('Connect a writable Google account before exporting data.');
    }
    throw new Error(destination.message);
  }

  async createAuthorizedOffer(payload: DataExportOfferPayload): Promise<{
    readonly offerId: string;
    readonly expiresAt: Date;
  }> {
    const { offer } = await this.persistAuthorized(payload);
    return { offerId: offer.id, expiresAt: offer.expiresAt };
  }

  /**
   * Record one tool call's dataset as part of this request's single export.
   *
   * A run that answers "compare these 22 domains" makes 22 provider calls and
   * shows one 22-row table. Creating an offer per call used to leave the first
   * call's single row wearing the whole answer's export button, so the sheet
   * silently disagreed with the screen. Parts sharing a shape key merge here
   * instead; anything else withdraws the offer rather than exporting a subset.
   */
  async appendAuthorizedPart(
    payload: DataExportOfferPayload,
    part: {
      readonly observedRowCount: number;
      /**
       * Title for the combined dataset once more than one call contributes.
       * Part 0's own title names a single lookup, which reads wrong on a file
       * holding twenty-two of them.
       */
      readonly collectionTitle?: string;
    },
  ): Promise<AppendDataExportPartResult> {
    const partShape = datasetSourceShapeKey(payload.source);
    let contended: DataExportOfferRecord | undefined;
    for (let attempt = 0; attempt < APPEND_RETRY_LIMIT; attempt += 1) {
      const now = this.deps.now?.() ?? new Date();
      const seeded: DataExportOfferPayload = {
        ...payload,
        observedRowCount: part.observedRowCount,
      };
      const created = await this.deps.offers.create({
        companyId: seeded.companyId,
        userId: seeded.userId,
        ...(seeded.departmentId ? { departmentId: seeded.departmentId } : {}),
        sourceKind: seeded.source.kind,
        sourceConnectionId: seeded.source.connectionId,
        payload: seeded,
        specHash: dataExportSpecHash(seeded),
        idempotencyKey: dataExportOfferKey(seeded),
        now,
        expiresAt: new Date(now.getTime() + DATA_EXPORT_OFFER_TTL_MS),
      });
      if (!created.ok) throw created.error;
      const offer = created.value.offer;
      if (created.value.outcome === 'created') {
        return {
          outcome: 'appended',
          offerId: offer.id,
          expiresAt: offer.expiresAt,
          partCount: 1,
          observedRowCount: part.observedRowCount,
        };
      }

      // An offer for this request already exists. It may only grow while it is
      // still pending, still belongs to this actor, and still describes the
      // same table.
      const existing = offer.payload;
      if (
        offer.userId !== seeded.userId
        || existing.chatId !== seeded.chatId
        || offer.status !== 'pending'
      ) {
        return await this.withdraw(offer, 'offer_not_appendable');
      }
      const parts = dataExportParts(existing);
      if (parts.some(source => datasetSourceShapeKey(source) !== partShape)) {
        return await this.withdraw(offer, 'shape_mismatch');
      }
      if (parts.length >= DATA_EXPORT_MAX_PARTS) {
        return await this.withdraw(offer, 'too_many_parts');
      }
      const duplicate = parts.some(
        source => sha256CanonicalJson(source) === sha256CanonicalJson(seeded.source),
      );
      // A retried provider call must not double the rows in the sheet.
      if (duplicate) {
        return {
          outcome: 'appended',
          offerId: offer.id,
          expiresAt: offer.expiresAt,
          partCount: parts.length,
          observedRowCount: existing.observedRowCount ?? part.observedRowCount,
        };
      }

      const partCount = parts.length + 1;
      const grown: DataExportOfferPayload = {
        ...existing,
        additionalParts: [...(existing.additionalParts ?? []), seeded.source],
        observedRowCount: (existing.observedRowCount ?? 0) + part.observedRowCount,
        ...(part.collectionTitle
          ? {
              destination: {
                ...existing.destination,
                title: `${part.collectionTitle} (${partCount})`,
              },
            }
          : {}),
      };
      const replaced = await this.deps.offers.replacePendingPayload({
        offerId: offer.id,
        companyId: offer.companyId,
        expectedSpecHash: offer.specHash,
        payload: grown,
        specHash: dataExportSpecHash(grown),
        now,
      });
      if (!replaced.ok) throw replaced.error;
      if (replaced.value.outcome === 'replaced') {
        return {
          outcome: 'appended',
          offerId: offer.id,
          expiresAt: offer.expiresAt,
          partCount,
          observedRowCount: grown.observedRowCount ?? part.observedRowCount,
        };
      }
      // Another part landed first. Re-read and try again against its payload.
      contended = offer;
    }
    // Losing every round means this part's rows are missing. Leaving the offer
    // live would put a button on an answer it no longer covers, which is the
    // exact failure this whole path exists to prevent.
    return contended
      ? await this.withdraw(contended, 'append_contention')
      : { outcome: 'withdrawn', reason: 'append_contention' };
  }

  private async withdraw(
    offer: DataExportOfferRecord,
    reason: AppendDataExportPartWithdrawal,
  ): Promise<AppendDataExportPartResult> {
    const cancelled = await this.deps.offers.cancelPending({
      offerId: offer.id,
      companyId: offer.companyId,
      ...(this.deps.now ? { now: this.deps.now() } : {}),
    });
    if (!cancelled.ok) throw cancelled.error;
    // Only claim a revocation this call actually performed. Parts 3..N of a
    // mismatched run find the offer already cancelled, and announcing 20
    // revocations of one offer — or revoking an export already being
    // delivered — would be a false report.
    return cancelled.value
      ? { outcome: 'withdrawn', reason, revokedOfferId: offer.id }
      : { outcome: 'withdrawn', reason };
  }

  private async persistAuthorized(payload: DataExportOfferPayload): Promise<{
    readonly now: Date;
    readonly offer: DataExportOfferRecord;
  }> {
    const now = this.deps.now?.() ?? new Date();
    const specHash = dataExportSpecHash(payload);
    const idempotencyKey = dataExportOfferKey(payload);
    const created = await this.deps.offers.create({
      companyId: payload.companyId,
      userId: payload.userId,
      ...(payload.departmentId ? { departmentId: payload.departmentId } : {}),
      sourceKind: payload.source.kind,
      sourceConnectionId: payload.source.connectionId,
      payload,
      specHash,
      idempotencyKey,
      now,
      expiresAt: new Date(now.getTime() + DATA_EXPORT_OFFER_TTL_MS),
    });
    if (!created.ok) throw created.error;
    this.assertSameRequest(created.value.offer, payload, specHash, idempotencyKey);
    return {
      now,
      offer: created.value.offer,
    };
  }

  private assertSameRequest(
    offer: DataExportOfferRecord,
    payload: DataExportOfferPayload,
    specHash: string,
    idempotencyKey: string,
  ): void {
    if (
      offer.companyId !== payload.companyId
      || offer.userId !== payload.userId
      || offer.specHash !== specHash
      || offer.idempotencyKey !== idempotencyKey
    ) {
      throw new Error(CONFLICT_MESSAGE);
    }
  }
}
