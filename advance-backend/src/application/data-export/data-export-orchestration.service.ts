import type { PermissionService } from '../permissions/permission.service';
import {
  menhoodQueryHasDeterministicReplayOrder,
  validateMenhoodQuery,
} from '../menhood/menhood-query';
import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import {
  asCompanyId,
  asDepartmentId,
  asToolId,
  asUserId,
} from '../../shared/ids';
import { sha256CanonicalJson } from '../../shared/hash';
import type {
  DataExportCandidateRecord,
  DataExportCandidateRepositoryPort,
  ExportCandidateMetadata,
  ExportPlanRequest,
} from './export-candidate';
import {
  DATA_EXPORT_CANDIDATE_TTL_MS,
} from './export-candidate';
import type { DataExportOfferPayload } from './export-offer';
import type { DataExportOfferService } from './data-export-offer.service';
import type { DataExportFormat } from './data-export-offer.service';
import type { DataExportDestinationChoice, ResolveDataExportDestination } from './data-export-destination-resolver';
import {
  dataExportParts,
  datasetSourceShapeKey,
  datasetSourceToolId,
} from './data-export.types';
import {
  summarizeExportCandidate,
  type ExportCandidateListItem,
} from './data-export-candidate-summary';

export type { ExportCandidateListItem };

export type DataExportPlanResult =
  | {
      readonly status: 'direct_queue';
      readonly planId: string;
      readonly exportJobId: string;
      readonly destinationLabel?: string;
    }
  | {
      readonly status: 'choose_destination';
      readonly planId: string;
      readonly connections: readonly DataExportDestinationChoice[];
    }
  | {
      readonly status: 'connect_required';
      readonly planId: string;
      readonly replyInThread: boolean;
      readonly replyToMessageId?: string;
    }
  | {
      readonly status: 'blocked';
      readonly reason: string;
      readonly message: string;
    }
  | {
      readonly status: 'ambiguous';
      readonly message: string;
    };

export class DataExportOrchestrationService {
  constructor(private readonly deps: {
    readonly candidates: DataExportCandidateRepositoryPort;
    readonly offers: Pick<DataExportOfferService, 'submitAuthorized'>;
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

  async publishCandidate(
    payload: DataExportOfferPayload,
    metadata: ExportCandidateMetadata,
  ): Promise<{
    readonly candidateId: string;
    readonly expiresAt: Date;
    readonly estimatedRows?: number;
  }> {
    const now = this.deps.now?.() ?? new Date();
    const created = await this.deps.candidates.createCandidate({
      payload,
      payloadHash: sha256CanonicalJson(payload),
      metadata,
      now,
      expiresAt: new Date(now.getTime() + DATA_EXPORT_CANDIDATE_TTL_MS),
    });
    if (!created.ok) throw created.error;
    return {
      candidateId: created.value.id,
      expiresAt: created.value.expiresAt,
      ...(created.value.estimatedRows === undefined ? {} : { estimatedRows: created.value.estimatedRows }),
    };
  }

  async listCandidatesForActor(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly scope?: 'chat' | 'run';
    readonly runRequestId?: string;
    readonly traceId?: string;
    readonly limit?: number;
  }): Promise<readonly ExportCandidateListItem[]> {
    const loaded = await this.deps.candidates.listActiveForActor({
      companyId: input.companyId,
      userId: input.userId,
      chatId: input.chatId,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.runRequestId ? { runRequestId: input.runRequestId } : {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(this.deps.now ? { now: this.deps.now() } : {}),
    });
    if (!loaded.ok) throw loaded.error;
    return loaded.value.map(summarizeExportCandidate);
  }

  async planForActor(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly progressMessageId?: string;
    readonly plan: ExportPlanRequest;
  }): Promise<DataExportPlanResult> {
    const prepared = await this.preparePlan(input);
    if (prepared.status !== 'prepared') return prepared;
    if (prepared.planRecord.status === 'full_queued' && prepared.planRecord.fullJobId) {
      return {
        status: 'direct_queue',
        planId: prepared.planRecord.id,
        exportJobId: prepared.planRecord.fullJobId,
      };
    }
    const destination = await this.resolveDestination(prepared, prepared.plan.destination.connectionId);
    if (destination.status === 'choose_destination') return { ...destination, planId: prepared.planRecord.id };
    if (destination.status === 'connect_required') return { ...destination, planId: prepared.planRecord.id };
    if (destination.status === 'blocked') return destination;
    const payload = this.payloadForPlan(prepared);
    const exportJobId = await this.deps.offers.submitAuthorized(
      payload,
      prepared.plan.destination.connectionId,
    );
    await this.deps.candidates.markFullQueued({
      planId: prepared.planRecord.id,
      companyId: input.companyId,
      userId: input.userId,
      fullJobId: exportJobId,
      ...(this.deps.now ? { now: this.deps.now() } : {}),
    });
    await this.rememberSelectedDestination(input, prepared.plan.destination.connectionId);
    return {
      status: 'direct_queue',
      planId: prepared.planRecord.id,
      exportJobId,
      ...(destination.label ? { destinationLabel: destination.label } : {}),
    };
  }

  private async preparePlan(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly progressMessageId?: string;
    readonly plan: ExportPlanRequest;
  }): Promise<PreparedPlan | Extract<DataExportPlanResult, { status: 'blocked' | 'ambiguous' }>> {
    const now = this.deps.now?.() ?? new Date();
    const candidateIds = input.plan.datasets.map(dataset => dataset.candidateId);
    const loaded = await this.deps.candidates.loadCandidatesForPlan({
      candidateIds,
      companyId: input.companyId,
      userId: input.userId,
      chatId: input.chatId,
      now,
    });
    if (!loaded.ok) throw loaded.error;
    if (loaded.value.length !== candidateIds.length) {
      return {
        status: 'blocked',
        reason: 'candidate_not_found',
        message: 'That exportable result is no longer active. Ask Divo to prepare the data again.',
      };
    }
    const permission = await this.resolvePermission(loaded.value[0]!);
    const blocked = this.validateCandidates(loaded.value, input.plan, permission);
    if (blocked) return blocked;
    const planHash = sha256CanonicalJson({
      plan: input.plan,
      candidatePayloadHashes: loaded.value.map(candidate => candidate.payloadHash),
    });
    const planRecord = await this.deps.candidates.upsertPlan({
      companyId: input.companyId,
      userId: input.userId,
      ...(loaded.value[0]!.departmentId ? { departmentId: loaded.value[0]!.departmentId } : {}),
      chatId: input.chatId,
      ...(loaded.value[0]!.conversationKey ? { conversationKey: loaded.value[0]!.conversationKey } : {}),
      candidateIds,
      plan: input.plan,
      planHash,
      destinationFormat: input.plan.destination.format,
      ...(input.plan.destination.connectionId ? { destinationConnectionId: input.plan.destination.connectionId } : {}),
      now,
      expiresAt: new Date(now.getTime() + DATA_EXPORT_CANDIDATE_TTL_MS),
    });
    if (!planRecord.ok) throw planRecord.error;
    return {
      status: 'prepared',
      candidates: loaded.value,
      plan: input.plan,
      planRecord: planRecord.value,
      ...(input.progressMessageId ? { progressMessageId: input.progressMessageId } : {}),
    };
  }

  private async resolvePermission(candidate: DataExportCandidateRecord) {
    const identity = await this.deps.identityRepo.resolveByUserId(candidate.userId, candidate.companyId);
    if (!identity.ok) throw identity.error;
    if (!identity.value) throw new Error('The export requester no longer has active company access.');
    const permission = await this.deps.permissions.resolve({
      companyId: asCompanyId(candidate.companyId),
      userId: asUserId(candidate.userId),
      companyRole: asCompanyRoleSlug(identity.value.aiRole),
      ...(candidate.departmentId ? { departmentId: asDepartmentId(candidate.departmentId) } : {}),
      channel: 'lark',
    });
    if (!permission.ok) throw permission.error;
    return permission.value;
  }

  private validateCandidates(
    candidates: readonly DataExportCandidateRecord[],
    plan: ExportPlanRequest,
    permission: Awaited<ReturnType<DataExportOrchestrationService['resolvePermission']>>,
  ): Extract<DataExportPlanResult, { status: 'blocked' | 'ambiguous' }> | null {
    if (!permission.allowedActionsByTool.get(asToolId('dataExport'))?.has('create')) {
      return {
        status: 'blocked',
        reason: 'permission_revoked',
        message: 'Your permission to create exports was removed before this export started.',
      };
    }
    for (const candidate of candidates) {
      const staleMenhoodBlock = validateMenhoodReplayCandidate(candidate);
      if (staleMenhoodBlock) return staleMenhoodBlock;
      const parts = dataExportParts(candidate.payload);
      for (const part of parts) {
        const sourceToolId = datasetSourceToolId(part);
        if (!permission.allowedActionsByTool.get(asToolId(sourceToolId))?.has('read')) {
          return {
            status: 'blocked',
            reason: 'source_permission_revoked',
            message: `Your permission to read ${sourceToolId} data was removed before this export started.`,
          };
        }
        if (
          (part.kind === 'zoho_books' || part.kind === 'zoho_crm')
          && permission.department?.zohoReadScope === 'personalized'
        ) {
          return {
            status: 'blocked',
            reason: 'personalized_zoho_scope',
            message: 'Complete Zoho exports need full company Zoho read access.',
          };
        }
      }
    }
    if (plan.destination.format === 'csv' && candidates.length > 1) {
      return {
        status: 'blocked',
        reason: 'csv_multi_dataset',
        message: 'CSV exports can contain one dataset. Choose Google Sheet or Excel for a workbook, or export one dataset.',
      };
    }
    const shapeKeys = new Set(candidates.flatMap(candidate =>
      dataExportParts(candidate.payload).map(datasetSourceShapeKey)
    ));
    const plannedWorkbook = isPlannedWorkbook(plan, candidates);
    if (shapeKeys.size > 1 && !plannedWorkbook) {
      return {
        status: 'ambiguous',
        message: 'This export combines datasets with different shapes. Plan one dataset, or assign a tabName to every dataset for a Sheet or Excel workbook.',
      };
    }
    if (plannedWorkbook && candidates.length !== plan.datasets.length) {
      return {
        status: 'ambiguous',
        message: 'Every workbook tab needs a matching export candidate in the plan.',
      };
    }
    return null;
  }

  private async resolveDestination(
    prepared: PreparedPlan,
    connectionId: string | undefined,
  ): Promise<{
    readonly status: 'selected';
    readonly label?: string;
  } | {
    readonly status: 'choose_destination';
    readonly connections: readonly DataExportDestinationChoice[];
  } | {
    readonly status: 'connect_required';
    readonly replyInThread: boolean;
    readonly replyToMessageId?: string;
  } | {
    readonly status: 'blocked';
    readonly reason: string;
    readonly message: string;
  }> {
    const first = prepared.candidates[0]!;
    const destination = await this.deps.resolveDestination({
      companyId: first.companyId,
      userId: first.userId,
      ...(connectionId ? { connectionId } : {}),
    });
    if (destination.status === 'selected') {
      return {
        status: 'selected',
        label: destination.target.kind === 'user_google'
          ? 'selected Google account'
          : 'Divo company Google account',
      };
    }
    if (destination.status === 'choose_connection') {
      return { status: 'choose_destination', connections: destination.connections };
    }
    if (destination.status === 'connect_required') {
      return {
        status: 'connect_required',
        replyInThread: first.payload.replyInThread === true,
        ...(first.payload.replyToMessageId ? { replyToMessageId: first.payload.replyToMessageId } : {}),
      };
    }
    return {
      status: 'blocked',
      reason: 'destination_unavailable',
      message: destination.message,
    };
  }

  private payloadForPlan(prepared: PreparedPlan): DataExportOfferPayload {
    const first = prepared.candidates[0]!;
    const destination = prepared.plan.destination;
    const workbookTabs = plannedWorkbookTabs(prepared);
    return {
      ...first.payload,
      source: first.payload.source,
      ...(workbookTabs
        ? { workbookTabs }
        : prepared.candidates.length > 1
          ? { additionalParts: prepared.candidates.slice(1).map(candidate => candidate.payload.source) }
          : {}),
      observedRowCount: prepared.candidates.reduce((total, candidate) => total + candidate.previewRowCount, 0),
      destination: {
        format: destination.format,
        title: destination.title,
        ...(destination.columns ? { columns: destination.columns } : {}),
      },
      exportKind: 'full',
      requestId: `${prepared.planRecord.id}:full`,
      ...(prepared.progressMessageId ? { progressMessageId: prepared.progressMessageId } : {}),
    };
  }

  private async rememberSelectedDestination(
    input: { readonly companyId: string; readonly userId: string },
    connectionId: string | undefined,
  ): Promise<void> {
    if (!connectionId) return;
    await this.deps.rememberDestination?.({
      companyId: input.companyId,
      userId: input.userId,
      connectionId,
    });
  }
}

type PreparedPlan = {
  readonly status: 'prepared';
  readonly candidates: readonly DataExportCandidateRecord[];
  readonly plan: ExportPlanRequest;
  readonly planRecord: {
    readonly id: string;
    readonly status: 'planned' | 'sample_queued' | 'sample_ready' | 'full_queued' | 'expired' | 'cancelled';
    readonly sampleJobId?: string;
    readonly fullJobId?: string;
  };
  readonly progressMessageId?: string;
};

function validateMenhoodReplayCandidate(
  candidate: DataExportCandidateRecord,
): Extract<DataExportPlanResult, { status: 'blocked' }> | null {
  if (candidate.sourceKind !== 'menhood_query') return null;
  if (!candidateLooksTruncated(candidate)) return null;
  for (const part of dataExportParts(candidate.payload)) {
    if (part.kind !== 'menhood_query') continue;
    const query = validateMenhoodQuery(part.query);
    if (!menhoodQueryHasDeterministicReplayOrder(query)) {
      return {
        status: 'blocked',
        reason: 'menhood_unordered_candidate',
        message: 'This Menhood exportable result was prepared without a deterministic ORDER BY. Ask Divo to prepare the data again with a stable ORDER BY before creating the full export; for order-line exports use o.order_date, o.order_number, o.id.',
      };
    }
  }
  return null;
}

function candidateLooksTruncated(candidate: DataExportCandidateRecord): boolean {
  const coverage = candidate.coverage as { readonly truncated?: unknown } | undefined;
  return coverage?.truncated === true
    || (candidate.previewRowCount >= 25 && candidate.estimatedRows === undefined);
}

function isPlannedWorkbook(
  plan: ExportPlanRequest,
  candidates: readonly DataExportCandidateRecord[],
): boolean {
  if (candidates.length <= 1) return false;
  if (plan.destination.format !== 'google_sheet' && plan.destination.format !== 'xlsx') {
    return false;
  }
  return plan.datasets.length === candidates.length
    && plan.datasets.every(dataset => Boolean(dataset.tabName));
}

function plannedWorkbookTabs(
  prepared: PreparedPlan,
): DataExportOfferPayload['workbookTabs'] | undefined {
  if (!isPlannedWorkbook(prepared.plan, prepared.candidates)) return undefined;
  return prepared.candidates.map((candidate, index) => ({
    source: candidate.payload.source,
    tabName: prepared.plan.datasets[index]!.tabName!,
  }));
}
