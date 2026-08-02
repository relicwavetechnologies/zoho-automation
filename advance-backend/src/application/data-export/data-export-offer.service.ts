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
  dataExportSpecHash,
} from './data-export.queue';
import {
  DATA_EXPORT_OFFER_TTL_MS,
  type DataExportOfferPayload,
  type DataExportOfferRecord,
  type DataExportOfferRepositoryPort,
} from './export-offer';
import { datasetSourceToolId } from './data-export.types';
import type { DataExportDestinationTarget } from './data-export.types';
import type {
  DataExportDestinationChoice,
  ResolveDataExportDestination,
} from './data-export-destination-resolver';

const CONFLICT_MESSAGE =
  'Only one data export can be queued per user request. Ask the user to choose one dataset before exporting.';

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
      dataExportJobId(offer.payload),
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
    const claimed = await this.deps.offers.claimConfirmation({
      offerId: expected.id,
      companyId: expected.companyId,
      userId: expected.userId,
      now,
    });
    if (!claimed.ok) throw claimed.error;
    if (claimed.value.outcome === 'already_confirmed') {
      return { exportJobId: claimed.value.queueJobId, disposition: 'already_confirmed' };
    }
    if (claimed.value.outcome === 'in_progress') {
      return { exportJobId: expected.idempotencyKey, disposition: 'in_progress' };
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
    const exportJobId = await this.deps.queue.enqueue({
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
    return { exportJobId, disposition: 'queued' };
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

  private async persistAuthorized(payload: DataExportOfferPayload): Promise<{
    readonly now: Date;
    readonly offer: DataExportOfferRecord;
  }> {
    const now = this.deps.now?.() ?? new Date();
    const specHash = dataExportSpecHash(payload);
    const idempotencyKey = dataExportJobId(payload);
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
