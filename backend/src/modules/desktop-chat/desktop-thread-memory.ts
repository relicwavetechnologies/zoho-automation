import { generateObject } from 'ai';
import { z } from 'zod';

import { resolveVercelLanguageModel } from '../../company/orchestration/vercel/model-factory';
import type { PendingApprovalAction, VercelToolEnvelope } from '../../company/orchestration/vercel/types';

export type DesktopThreadSummary = {
  summary?: string;
  latestObjective?: string;
  latestUserGoal?: string;
  userGoals: string[];
  activeEntities: string[];
  resolvedReferences: string[];
  completedActions: string[];
  completedWrites: string[];
  pendingApprovals: string[];
  constraints: string[];
  sourceMessageCount: number;
  updatedAt: string;
};

export type DesktopEntityRef = {
  module: string;
  recordId: string;
  label?: string;
  updatedAt: string;
};

export type DesktopSourceArtifact = {
  fileAssetId: string;
  fileName: string;
  sourceType: 'uploaded_file' | 'company_file';
  documentKey?: string;
  summary?: string;
  retrievalHint?: string;
  addedAt: string;
  lastUsedAt: string;
};

export type DesktopWorkingSet = {
  domain: string;
  module: string;
  organizationId?: string;
  recordIds: string[];
  ordinalMap: Record<string, string>;
  labelsByRecordId: Record<string, string>;
  updatedAt: string;
};

export type DesktopCompletedMutation = {
  operation: string;
  module?: string;
  recordId?: string;
  summary: string;
  ok: boolean;
  updatedAt: string;
};

export type DesktopPendingApprovalState = {
  approvalId?: string;
  toolId: string;
  actionGroup?: string;
  operation: string;
  module?: string;
  recordId?: string;
  subject?: string;
  summary: string;
  payload?: Record<string, unknown>;
  updatedAt: string;
};

export type DesktopTaskState = {
  activeDomain?: string;
  activeModule?: string;
  activeObjective?: string;
  activeSourceArtifacts: DesktopSourceArtifact[];
  workingSets: Record<string, DesktopWorkingSet>;
  aliases: Record<string, DesktopEntityRef>;
  currentEntity?: DesktopEntityRef;
  lastFetchedByModule: Record<string, DesktopEntityRef>;
  completedMutations: DesktopCompletedMutation[];
  pendingApproval?: DesktopPendingApprovalState | null;
  latestActionResult?: {
    kind: string;
    ok: boolean;
    summary: string;
    updatedAt: string;
  };
  updatedAt: string;
};

type ThreadMessageLike = {
  role: string;
  content: string;
};

const isLightweightChatLike = (value: string | null | undefined): boolean =>
  /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|nice|yes|no|done)[.! ]*$/i.test((value ?? '').trim());

const isQueueOrStatusOnlyText = (value: string): boolean =>
  /^(working on it\.?|still working on it\.?|still working through the next step\.?|still gathering the right details\.?|getting things ready\.?|queued your message\.?|send \/q to interrupt the active run\.?|there (?:is|are) \d+ requests ahead of it\.)$/i.test(value);

const isRawInternalAssistantText = (value: string): boolean => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  if (isQueueOrStatusOnlyText(normalized)) return true;
  if (
    /^approval required before continuing:/i.test(normalized)
    || /^multiple saved workflows matched /i.test(normalized)
    || /^continue from this local action result\./i.test(normalized)
  ) {
    return true;
  }
  if (
    /\b(?:create|update|delete|run|build|save|schedule|workflow\w*|mark\w*|email\w*|submit\w*|approve\w*|open\w*|void\w*) requires\b/i.test(normalized)
    || /\bneed[s]? both a dayofweek and time\b/i.test(normalized)
    || /\bask the user\b/i.test(normalized)
  ) {
    return true;
  }
  return false;
};

export const shouldOmitFromThreadContext = (message: ThreadMessageLike): boolean => {
  const normalized = message.content.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return true;
  }
  if (isLightweightChatLike(normalized)) {
    return true;
  }
  if (message.role === 'assistant') {
    if (isRawInternalAssistantText(normalized)) {
      return true;
    }
    if (normalized.startsWith('I need a bit more information before I can finish this.')) {
      return true;
    }
  }
  if (message.role === 'user' && /^continue from this local action result\./i.test(normalized)) {
    return true;
  }
  return false;
};

export const filterThreadMessagesForContext = <T extends ThreadMessageLike>(messages: T[]): T[] =>
  messages.filter((message) => !shouldOmitFromThreadContext(message));

const summarySchema = z.object({
  summary: z.string().trim().max(1600).optional(),
  latestObjective: z.string().trim().max(300).optional(),
  latestUserGoal: z.string().trim().max(300).optional(),
  userGoals: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  activeEntities: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  resolvedReferences: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  completedActions: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  completedWrites: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  pendingApprovals: z.array(z.string().trim().min(1).max(300)).max(6).default([]),
  constraints: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
});

const emptySummary = (): DesktopThreadSummary => ({
  activeEntities: [],
  completedActions: [],
  userGoals: [],
  resolvedReferences: [],
  completedWrites: [],
  pendingApprovals: [],
  constraints: [],
  sourceMessageCount: 0,
  updatedAt: new Date(0).toISOString(),
});

export const createEmptyTaskState = (): DesktopTaskState => ({
  activeSourceArtifacts: [],
  workingSets: {},
  aliases: {},
  lastFetchedByModule: {},
  completedMutations: [],
  pendingApproval: null,
  updatedAt: new Date(0).toISOString(),
});

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asArrayOfRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
      const record = asRecord(entry);
      return record ? [record] : [];
    })
    : [];

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const summarizeText = (value: string, maxLength = 220): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;

export const parseDesktopThreadSummary = (value: unknown): DesktopThreadSummary => {
  const record = asRecord(value);
  if (!record) {
    return emptySummary();
  }

  return {
    summary: asString(record.summary),
    latestObjective: asString(record.latestObjective),
    latestUserGoal: asString(record.latestUserGoal),
    userGoals: Array.isArray(record.userGoals) ? record.userGoals.flatMap((entry) => asString(entry) ? [asString(entry)!] : []).slice(0, 8) : [],
    activeEntities: Array.isArray(record.activeEntities) ? record.activeEntities.flatMap((entry) => asString(entry) ? [asString(entry)!] : []).slice(0, 8) : [],
    resolvedReferences: Array.isArray(record.resolvedReferences) ? record.resolvedReferences.flatMap((entry) => asString(entry) ? [asString(entry)!] : []).slice(0, 10) : [],
    completedActions: Array.isArray(record.completedActions) ? record.completedActions.flatMap((entry) => asString(entry) ? [asString(entry)!] : []).slice(0, 10) : [],
    completedWrites: Array.isArray(record.completedWrites) ? record.completedWrites.flatMap((entry) => asString(entry) ? [asString(entry)!] : []).slice(0, 10) : [],
    pendingApprovals: Array.isArray(record.pendingApprovals) ? record.pendingApprovals.flatMap((entry) => asString(entry) ? [asString(entry)!] : []).slice(0, 6) : [],
    constraints: Array.isArray(record.constraints) ? record.constraints.flatMap((entry) => asString(entry) ? [asString(entry)!] : []).slice(0, 8) : [],
    sourceMessageCount: typeof record.sourceMessageCount === 'number' ? record.sourceMessageCount : 0,
    updatedAt: asString(record.updatedAt) ?? new Date(0).toISOString(),
  };
};

export const parseDesktopTaskState = (value: unknown): DesktopTaskState => {
  const record = asRecord(value);
  if (!record) {
    return createEmptyTaskState();
  }

  const workingSets = asRecord(record.workingSets) ?? {};
  const aliases = asRecord(record.aliases) ?? {};
  const lastFetchedByModule = asRecord(record.lastFetchedByModule) ?? {};

  const normalizeEntity = (input: unknown): DesktopEntityRef | undefined => {
    const candidate = asRecord(input);
    if (!candidate) return undefined;
    const module = asString(candidate.module);
    const recordId = asString(candidate.recordId);
    if (!module || !recordId) return undefined;
    return {
      module,
      recordId,
      label: asString(candidate.label),
      updatedAt: asString(candidate.updatedAt) ?? new Date().toISOString(),
    };
  };

  const activeSourceArtifacts = Array.isArray(record.activeSourceArtifacts)
    ? record.activeSourceArtifacts.flatMap((entry) => {
      const candidate = asRecord(entry);
      const fileAssetId = asString(candidate?.fileAssetId);
      const fileName = asString(candidate?.fileName);
      if (!fileAssetId || !fileName) return [];
      const sourceType = asString(candidate?.sourceType);
      return [{
        fileAssetId,
        fileName,
        sourceType: sourceType === 'company_file' ? 'company_file' : 'uploaded_file',
        documentKey: asString(candidate?.documentKey),
        summary: asString(candidate?.summary),
        retrievalHint: asString(candidate?.retrievalHint),
        addedAt: asString(candidate?.addedAt) ?? new Date().toISOString(),
        lastUsedAt: asString(candidate?.lastUsedAt) ?? new Date().toISOString(),
      } satisfies DesktopSourceArtifact];
    }).slice(0, 8)
    : [];

  const normalizeWorkingSet = (input: unknown): DesktopWorkingSet | undefined => {
    const candidate = asRecord(input);
    if (!candidate) return undefined;
    const module = asString(candidate.module);
    if (!module) return undefined;
    const recordIds = Array.isArray(candidate.recordIds)
      ? candidate.recordIds.flatMap((entry) => asString(entry) ? [asString(entry)!] : []).slice(0, 50)
      : [];
    const ordinalMapRecord = asRecord(candidate.ordinalMap) ?? {};
    const labelsRecord = asRecord(candidate.labelsByRecordId) ?? {};
    return {
      domain: asString(candidate.domain) ?? 'zoho-books',
      module,
      organizationId: asString(candidate.organizationId),
      recordIds,
      ordinalMap: Object.fromEntries(
        Object.entries(ordinalMapRecord)
          .flatMap(([key, value]) => {
            const recordId = asString(value);
            return recordId ? [[key, recordId]] : [];
          }),
      ),
      labelsByRecordId: Object.fromEntries(
        Object.entries(labelsRecord)
          .flatMap(([key, value]) => {
            const label = asString(value);
            return label ? [[key, label]] : [];
          }),
      ),
      updatedAt: asString(candidate.updatedAt) ?? new Date().toISOString(),
    };
  };

  const completedMutations = Array.isArray(record.completedMutations)
    ? record.completedMutations.flatMap((entry) => {
      const candidate = asRecord(entry);
      const operation = asString(candidate?.operation);
      const summary = asString(candidate?.summary);
      if (!operation || !summary) return [];
      return [{
        operation,
        module: asString(candidate?.module),
        recordId: asString(candidate?.recordId),
        summary,
        ok: typeof candidate?.ok === 'boolean' ? candidate.ok : false,
        updatedAt: asString(candidate?.updatedAt) ?? new Date().toISOString(),
      } satisfies DesktopCompletedMutation];
    }).slice(-12)
    : [];

  const pendingApprovalRecord = asRecord(record.pendingApproval);
  const pendingApproval = pendingApprovalRecord
    ? {
      approvalId: asString(pendingApprovalRecord.approvalId),
      toolId: asString(pendingApprovalRecord.toolId) ?? 'unknown-tool',
      actionGroup: asString(pendingApprovalRecord.actionGroup),
      operation: asString(pendingApprovalRecord.operation) ?? 'unknown',
      module: asString(pendingApprovalRecord.module),
      recordId: asString(pendingApprovalRecord.recordId),
      subject: asString(pendingApprovalRecord.subject),
      summary: asString(pendingApprovalRecord.summary) ?? 'Approval pending',
      payload: asRecord(pendingApprovalRecord.payload),
      updatedAt: asString(pendingApprovalRecord.updatedAt) ?? new Date().toISOString(),
    } satisfies DesktopPendingApprovalState
    : null;

  const latestActionResultRecord = asRecord(record.latestActionResult);

  return {
    activeDomain: asString(record.activeDomain),
    activeModule: asString(record.activeModule),
    activeObjective: asString(record.activeObjective),
    activeSourceArtifacts,
    workingSets: Object.fromEntries(
      Object.entries(workingSets).flatMap(([key, value]) => {
        const parsed = normalizeWorkingSet(value);
        return parsed ? [[key, parsed]] : [];
      }),
    ),
    aliases: Object.fromEntries(
      Object.entries(aliases).flatMap(([key, value]) => {
        const parsed = normalizeEntity(value);
        return parsed ? [[key, parsed]] : [];
      }),
    ),
    currentEntity: normalizeEntity(record.currentEntity),
    lastFetchedByModule: Object.fromEntries(
      Object.entries(lastFetchedByModule).flatMap(([key, value]) => {
        const parsed = normalizeEntity(value);
        return parsed ? [[key, parsed]] : [];
      }),
    ),
    completedMutations,
    pendingApproval,
    latestActionResult: latestActionResultRecord
      ? {
        kind: asString(latestActionResultRecord.kind) ?? 'unknown',
        ok: typeof latestActionResultRecord.ok === 'boolean' ? latestActionResultRecord.ok : false,
        summary: asString(latestActionResultRecord.summary) ?? '',
        updatedAt: asString(latestActionResultRecord.updatedAt) ?? new Date().toISOString(),
      }
      : undefined,
    updatedAt: asString(record.updatedAt) ?? new Date(0).toISOString(),
  };
};

const extractBooksModule = (envelope: VercelToolEnvelope): string | undefined =>
  asString(envelope.keyData?.module)
  ?? asString(envelope.pendingApprovalAction && envelope.pendingApprovalAction.kind === 'tool_action'
    ? envelope.pendingApprovalAction.payload.module
    : undefined);

const extractBooksRecordId = (moduleName: string, record: Record<string, unknown>): string | undefined => {
  const normalizedModule = moduleName.toLowerCase();
  const candidates = normalizedModule === 'contacts'
    ? [record.contact_id, record.id]
    : normalizedModule === 'invoices'
      ? [record.invoice_id, record.id]
      : normalizedModule === 'estimates'
        ? [record.estimate_id, record.id]
        : normalizedModule === 'creditnotes'
          ? [record.creditnote_id, record.id]
          : normalizedModule === 'bills'
            ? [record.bill_id, record.id]
            : normalizedModule === 'salesorders'
              ? [record.salesorder_id, record.id]
              : normalizedModule === 'purchaseorders'
                ? [record.purchaseorder_id, record.id]
                : normalizedModule === 'customerpayments'
                  ? [record.payment_id, record.customer_payment_id, record.id]
                  : normalizedModule === 'vendorpayments'
                    ? [record.payment_id, record.vendor_payment_id, record.id]
                    : normalizedModule === 'bankaccounts'
                      ? [record.account_id, record.id]
                      : [record.bank_transaction_id, record.transaction_id, record.id];
  for (const candidate of candidates) {
    const value = asString(candidate);
    if (value) return value;
  }
  return undefined;
};

const extractBooksRecordLabel = (moduleName: string, record: Record<string, unknown>): string | undefined => {
  const normalizedModule = moduleName.toLowerCase();
  const candidates = normalizedModule === 'invoices'
    ? [record.invoice_number, record.customer_name, record.reference_number]
    : normalizedModule === 'estimates'
      ? [record.estimate_number, record.customer_name, record.reference_number]
      : normalizedModule === 'bills'
        ? [record.bill_number, record.vendor_name, record.reference_number]
        : normalizedModule === 'contacts'
          ? [record.contact_name, record.company_name, record.email]
          : normalizedModule === 'salesorders'
            ? [record.salesorder_number, record.customer_name]
            : normalizedModule === 'purchaseorders'
              ? [record.purchaseorder_number, record.vendor_name]
              : [record.reference_number, record.name, record.description];
  for (const candidate of candidates) {
    const value = asString(candidate);
    if (value) return value;
  }
  return undefined;
};

const extractBooksEntityFromActionPayload = (input: {
  payload?: Record<string, unknown>;
  fallbackModule?: string;
  updatedAt: string;
}): DesktopEntityRef | null => {
  const payload = asRecord(input.payload);
  if (!payload) {
    return null;
  }

  const nestedCandidates: Array<[string, Record<string, unknown> | null]> = [
    ['invoices', asRecord(payload.invoice)],
    ['estimates', asRecord(payload.estimate)],
    ['contacts', asRecord(payload.contact)],
    ['bills', asRecord(payload.bill)],
    ['salesorders', asRecord(payload.salesorder)],
    ['purchaseorders', asRecord(payload.purchaseorder)],
  ];

  for (const [moduleName, record] of nestedCandidates) {
    if (!record) {
      continue;
    }
    const recordId = extractBooksRecordId(moduleName, record);
    if (!recordId) {
      continue;
    }
    return {
      module: moduleName,
      recordId,
      label: extractBooksRecordLabel(moduleName, record),
      updatedAt: input.updatedAt,
    };
  }

  const fallbackModule = asString(input.fallbackModule);
  if (!fallbackModule) {
    return null;
  }
  const fallbackRecordId = extractBooksRecordId(fallbackModule, payload);
  if (!fallbackRecordId) {
    return null;
  }
  return {
    module: fallbackModule,
    recordId: fallbackRecordId,
    label: extractBooksRecordLabel(fallbackModule, payload),
    updatedAt: input.updatedAt,
  };
};

const buildWorkingSet = (moduleName: string, organizationId: string | undefined, items: Record<string, unknown>[]): DesktopWorkingSet => {
  const now = new Date().toISOString();
  const labelsByRecordId: Record<string, string> = {};
  const recordIds: string[] = [];
  const ordinalMap: Record<string, string> = {};

  for (const [index, item] of items.entries()) {
    const recordId = extractBooksRecordId(moduleName, item);
    if (!recordId) continue;
    recordIds.push(recordId);
    ordinalMap[String(index + 1)] = recordId;
    const label = extractBooksRecordLabel(moduleName, item);
    if (label) {
      labelsByRecordId[recordId] = label;
    }
  }

  return {
    domain: 'zoho-books',
    module: moduleName,
    organizationId,
    recordIds: recordIds.slice(0, 50),
    ordinalMap,
    labelsByRecordId,
    updatedAt: now,
  };
};

export const buildTaskStateContext = (taskState: DesktopTaskState): string | null => {
  const lines: string[] = [];
  if (taskState.activeObjective) {
    lines.push(`Active objective: ${taskState.activeObjective}`);
  }
  if (taskState.activeDomain || taskState.activeModule) {
    lines.push(`Active task domain: ${taskState.activeDomain ?? 'unknown'}${taskState.activeModule ? ` / module=${taskState.activeModule}` : ''}`);
  }
  if (taskState.activeSourceArtifacts.length > 0) {
    lines.push(`Active source artifacts: ${taskState.activeSourceArtifacts.slice(0, 4).map((artifact) => artifact.fileName).join(' | ')}`);
  }
  if (taskState.currentEntity) {
    lines.push(`Current entity: ${taskState.currentEntity.module} ${taskState.currentEntity.recordId}${taskState.currentEntity.label ? ` (${taskState.currentEntity.label})` : ''}`);
  }
  const workingSet = taskState.activeModule ? taskState.workingSets[taskState.activeModule] : undefined;
  if (workingSet && workingSet.recordIds.length > 0) {
    const ordinalPreview = Object.entries(workingSet.ordinalMap)
      .slice(0, 12)
      .map(([ordinal, recordId]) => `${ordinal} -> ${recordId}${workingSet.labelsByRecordId[recordId] ? ` (${workingSet.labelsByRecordId[recordId]})` : ''}`);
    if (ordinalPreview.length > 0) {
      lines.push(`Current working set for ${workingSet.module}: ${ordinalPreview.join('; ')}`);
    }
  }
  if (taskState.pendingApproval) {
    lines.push(`Pending approval: ${taskState.pendingApproval.summary}`);
    lines.push([
      'Pending approval details:',
      `tool=${taskState.pendingApproval.toolId}`,
      `operation=${taskState.pendingApproval.operation}`,
      taskState.pendingApproval.actionGroup ? `actionGroup=${taskState.pendingApproval.actionGroup}` : null,
      taskState.pendingApproval.module ? `module=${taskState.pendingApproval.module}` : null,
      taskState.pendingApproval.recordId ? `recordId=${taskState.pendingApproval.recordId}` : null,
      taskState.pendingApproval.approvalId ? `approvalId=${taskState.pendingApproval.approvalId}` : null,
      taskState.pendingApproval.payload ? `payloadKeys=${Object.keys(taskState.pendingApproval.payload).slice(0, 12).join(',')}` : null,
    ].filter(Boolean).join(' '));
  }
  if (taskState.completedMutations.length > 0) {
    const recentMutations = taskState.completedMutations
      .slice(-4)
      .map((mutation) => mutation.summary);
    lines.push(`Recent completed mutations: ${recentMutations.join(' | ')}`);
  }
  if (taskState.latestActionResult?.summary) {
    lines.push(`Latest action result: ${taskState.latestActionResult.summary}`);
  }
  return lines.length > 0 ? ['Structured task state:', ...lines].join('\n') : null;
};

export const buildThreadSummaryContext = (summary: DesktopThreadSummary): string | null => {
  const lines: string[] = [];
  if (summary.summary) {
    lines.push(`Summary: ${summary.summary}`);
  }
  if (summary.latestObjective) {
    lines.push(`Latest objective: ${summary.latestObjective}`);
  }
  if (summary.latestUserGoal) {
    lines.push(`Latest user goal: ${summary.latestUserGoal}`);
  }
  if (summary.userGoals.length > 0) {
    lines.push(`User goals: ${summary.userGoals.join(' | ')}`);
  }
  if (summary.activeEntities.length > 0) {
    lines.push(`Active entities: ${summary.activeEntities.join(' | ')}`);
  }
  if (summary.resolvedReferences.length > 0) {
    lines.push(`Resolved refs: ${summary.resolvedReferences.join(' | ')}`);
  }
  if (summary.completedActions.length > 0) {
    lines.push(`Completed actions: ${summary.completedActions.join(' | ')}`);
  }
  if (summary.completedWrites.length > 0) {
    lines.push(`Completed writes: ${summary.completedWrites.join(' | ')}`);
  }
  if (summary.pendingApprovals.length > 0) {
    lines.push(`Pending approvals: ${summary.pendingApprovals.join(' | ')}`);
  }
  if (summary.constraints.length > 0) {
    lines.push(`Constraints: ${summary.constraints.join(' | ')}`);
  }
  return lines.length > 0 ? ['Thread summary:', ...lines].join('\n') : null;
};

export const resolveDesktopTaskReferences = (message: string, taskState: DesktopTaskState): {
  message: string;
  resolvedReferences: string[];
} => {
  const trimmed = message.trim();
  if (!trimmed) {
    return { message, resolvedReferences: [] };
  }

  const resolved: string[] = [];
  const workingSet = taskState.activeModule ? taskState.workingSets[taskState.activeModule] : undefined;
  if (workingSet) {
    const ordinalMatches = Array.from(trimmed.matchAll(/\b(\d+)(st|nd|rd|th)\b/gi));
    for (const match of ordinalMatches) {
      const ordinal = match[1];
      const recordId = workingSet.ordinalMap[ordinal];
      if (!recordId) continue;
      const label = workingSet.labelsByRecordId[recordId];
      resolved.push(`"${match[0]}" refers to ${workingSet.module} record ${recordId}${label ? ` (${label})` : ''}.`);
    }

    if (/\b(last|latest)\s+(one|record|estimate|invoice|bill|contact)\b/i.test(trimmed) && workingSet.recordIds.length > 0) {
      const recordId = workingSet.recordIds[workingSet.recordIds.length - 1]!;
      const label = workingSet.labelsByRecordId[recordId];
      resolved.push(`"last" refers to ${workingSet.module} record ${recordId}${label ? ` (${label})` : ''}.`);
    }
  }

  if (/\b(that|same)\s+(one|record|estimate|invoice|bill|contact)\b/i.test(trimmed) && taskState.currentEntity) {
    resolved.push(`"${trimmed.match(/\b(that|same)\s+(one|record|estimate|invoice|bill|contact)\b/i)?.[0] ?? 'same one'}" refers to ${taskState.currentEntity.module} record ${taskState.currentEntity.recordId}${taskState.currentEntity.label ? ` (${taskState.currentEntity.label})` : ''}.`);
  }

  if (resolved.length === 0) {
    return { message, resolvedReferences: [] };
  }

  return {
    message: `${trimmed}\n\nResolved entity context:\n- ${resolved.join('\n- ')}`,
    resolvedReferences: resolved,
  };
};

const SOURCE_ARTIFACT_LIMIT = 8;

const FOLLOW_UP_SOURCE_PATTERN = /\b(next task|pick the next|move on|move to next|continue|next one|what next|do the next)\b/i;
const DOC_GROUNDED_PATTERN = /\b(document|doc|file|csv|sheet|spreadsheet|task list|assignment)\b/i;

export const upsertDesktopSourceArtifacts = (input: {
  taskState: DesktopTaskState;
  artifacts: Array<{
    fileAssetId: string;
    fileName: string;
    sourceType?: 'uploaded_file' | 'company_file';
    documentKey?: string;
    summary?: string;
    retrievalHint?: string;
  }>;
}): DesktopTaskState => {
  const next = parseDesktopTaskState(input.taskState);
  const now = new Date().toISOString();
  const merged = [...next.activeSourceArtifacts];

  for (const artifact of input.artifacts) {
    const fileAssetId = artifact.fileAssetId.trim();
    const fileName = artifact.fileName.trim();
    if (!fileAssetId || !fileName) continue;
    const existing = merged.findIndex((entry) => entry.fileAssetId === fileAssetId);
    const current = existing >= 0 ? merged[existing] : undefined;
    const normalized: DesktopSourceArtifact = {
      fileAssetId,
      fileName,
      sourceType: artifact.sourceType ?? current?.sourceType ?? 'uploaded_file',
      documentKey: artifact.documentKey ?? current?.documentKey,
      summary: artifact.summary ?? current?.summary,
      retrievalHint: artifact.retrievalHint ?? current?.retrievalHint,
      addedAt: current?.addedAt ?? now,
      lastUsedAt: now,
    };
    if (existing >= 0) {
      merged.splice(existing, 1);
    }
    merged.unshift(normalized);
  }

  next.activeSourceArtifacts = merged.slice(0, SOURCE_ARTIFACT_LIMIT);
  next.updatedAt = now;
  return next;
};

export const markDesktopSourceArtifactsUsed = (input: {
  taskState: DesktopTaskState;
  fileAssetIds: string[];
}): DesktopTaskState => {
  if (input.fileAssetIds.length === 0) {
    return parseDesktopTaskState(input.taskState);
  }
  const next = parseDesktopTaskState(input.taskState);
  const now = new Date().toISOString();
  const prioritized: DesktopSourceArtifact[] = [];
  const remaining = [...next.activeSourceArtifacts];
  for (const fileAssetId of input.fileAssetIds) {
    const index = remaining.findIndex((entry) => entry.fileAssetId === fileAssetId);
    if (index < 0) continue;
    const [artifact] = remaining.splice(index, 1);
    prioritized.push({
      ...artifact,
      lastUsedAt: now,
    });
  }
  next.activeSourceArtifacts = [...prioritized, ...remaining].slice(0, SOURCE_ARTIFACT_LIMIT);
  next.updatedAt = now;
  return next;
};

export const selectDesktopSourceArtifacts = (input: {
  taskState: DesktopTaskState;
  message?: string;
  limit?: number;
}): DesktopSourceArtifact[] => {
  const artifacts = input.taskState.activeSourceArtifacts;
  if (artifacts.length === 0) return [];

  const limit = Math.max(1, Math.min(SOURCE_ARTIFACT_LIMIT, input.limit ?? 3));
  const trimmed = input.message?.trim().toLowerCase() ?? '';
  if (!trimmed) {
    return artifacts.slice(0, limit);
  }

  const matchedByName = artifacts.filter((artifact) => trimmed.includes(artifact.fileName.toLowerCase()));
  if (matchedByName.length > 0) {
    const matchedIds = new Set(matchedByName.map((artifact) => artifact.fileAssetId));
    return [...matchedByName, ...artifacts.filter((artifact) => !matchedIds.has(artifact.fileAssetId))].slice(0, limit);
  }

  if (FOLLOW_UP_SOURCE_PATTERN.test(trimmed) || DOC_GROUNDED_PATTERN.test(trimmed)) {
    return artifacts.slice(0, limit);
  }

  return [];
};

const mergeUnique = (current: string[], incoming: string[], maxLength: number): string[] => {
  const merged = [...current];
  for (const value of incoming) {
    if (!merged.includes(value)) {
      merged.push(value);
    }
  }
  return merged.slice(-maxLength);
};

export const THREAD_SUMMARY_RECENT_WINDOW_MESSAGE_COUNT = 12;
const THREAD_SUMMARY_MIN_MESSAGE_COUNT = 16;
const THREAD_SUMMARY_REFRESH_DELTA = 6;

const collectActiveEntities = (taskState: DesktopTaskState): string[] => {
  const activeEntities: string[] = [];
  if (taskState.currentEntity) {
    activeEntities.push(
      `${taskState.currentEntity.module}:${taskState.currentEntity.recordId}${taskState.currentEntity.label ? ` (${taskState.currentEntity.label})` : ''}`,
    );
  }
  for (const artifact of taskState.activeSourceArtifacts.slice(0, 4)) {
    activeEntities.push(`source:${artifact.fileName}`);
  }
  return activeEntities;
};

const buildDeterministicNarrativeSummary = (input: {
  latestObjective?: string;
  latestUserGoal?: string;
  userGoals: string[];
  activeEntities: string[];
  completedActions: string[];
  pendingApprovals: string[];
  constraints: string[];
}): string | undefined => {
  const parts: string[] = [];
  if (input.latestObjective) {
    parts.push(`Current objective: ${input.latestObjective}.`);
  }
  if (input.latestUserGoal && input.latestUserGoal !== input.latestObjective) {
    parts.push(`Latest user goal: ${input.latestUserGoal}.`);
  }
  if (input.userGoals.length > 0) {
    parts.push(`Recent goals: ${input.userGoals.slice(-3).join(' | ')}.`);
  }
  if (input.activeEntities.length > 0) {
    parts.push(`Active entities: ${input.activeEntities.slice(0, 4).join(' | ')}.`);
  }
  if (input.completedActions.length > 0) {
    parts.push(`Recent completed actions: ${input.completedActions.slice(-3).join(' | ')}.`);
  }
  if (input.pendingApprovals.length > 0) {
    parts.push(`Pending approvals: ${input.pendingApprovals.join(' | ')}.`);
  }
  if (input.constraints.length > 0) {
    parts.push(`Constraints: ${input.constraints.slice(-3).join(' | ')}.`);
  }
  const summary = parts.join(' ').trim();
  return summary ? summarizeText(summary, 1500) : undefined;
};

export const updateTaskStateFromToolEnvelope = (input: {
  taskState: DesktopTaskState;
  toolName: string;
  output: VercelToolEnvelope;
  latestObjective?: string;
}): DesktopTaskState => {
  const next = parseDesktopTaskState(input.taskState);
  const now = new Date().toISOString();
  next.updatedAt = now;
  if (input.latestObjective?.trim()) {
    next.activeObjective = summarizeText(input.latestObjective.trim(), 300);
  }

  if (input.toolName === 'booksRead' && input.output.success) {
    const moduleName = extractBooksModule(input.output);
    const fullPayload = asRecord(input.output.fullPayload);
    const keyData = asRecord(input.output.keyData);
    if (moduleName) {
      next.activeDomain = 'zoho-books';
      next.activeModule = moduleName;
    }

    const records = asArrayOfRecords(fullPayload?.records);
    if (moduleName && records.length > 0) {
      const organizationId = asString(fullPayload?.organizationId) ?? asString(keyData?.organizationId);
      next.workingSets[moduleName] = buildWorkingSet(moduleName, organizationId, records);
    } else if (moduleName && keyData && asString(keyData.recordId)) {
      const recordId = asString(keyData.recordId)!;
      const label = asString(fullPayload?.estimate_number) ?? asString(fullPayload?.invoice_number) ?? asString(fullPayload?.contact_name);
      const entity: DesktopEntityRef = {
        module: moduleName,
        recordId,
        ...(label ? { label } : {}),
        updatedAt: now,
      };
      next.currentEntity = entity;
      next.lastFetchedByModule[moduleName] = entity;
      next.aliases[recordId] = entity;
      if (label) {
        next.aliases[label.toLowerCase()] = entity;
      }
    }
  }

  if (input.toolName === 'docSearch' && input.output.success) {
    const fullPayload = asRecord(input.output.fullPayload);
    const matches = Array.isArray(fullPayload?.matches) ? fullPayload.matches : [];
    if (matches.length > 0) {
      return upsertDesktopSourceArtifacts({
        taskState: next,
        artifacts: matches.flatMap((entry) => {
          const record = asRecord(entry);
          const fileAssetId = asString(record?.sourceId);
          const fileName = asString(record?.fileName);
          if (!fileAssetId || !fileName) return [];
          return [{
            fileAssetId,
            fileName,
            sourceType: 'company_file' as const,
          }];
        }),
      });
    }
  }

  const pending = input.output.pendingApprovalAction;
  if (input.toolName === 'booksWrite' && pending?.kind === 'tool_action') {
    const payload = asRecord(pending.payload);
    next.activeDomain = 'zoho-books';
    next.activeModule = asString(payload?.module) ?? next.activeModule;
    next.pendingApproval = {
      approvalId: pending.approvalId,
      toolId: pending.toolId,
      actionGroup: pending.actionGroup,
      operation: pending.operation,
      module: asString(payload?.module),
      recordId: asString(payload?.recordId)
        ?? asString(payload?.estimateId)
        ?? asString(payload?.invoiceId)
        ?? asString(payload?.billId)
        ?? asString(payload?.contactId),
      subject: pending.subject,
      summary: pending.summary,
      payload,
      updatedAt: now,
    };
  }

  return next;
};

export const applyActionResultToTaskState = (input: {
  taskState: DesktopTaskState;
  actionResult?: { kind: string; ok: boolean; summary: string; payload?: Record<string, unknown> } | null;
}): DesktopTaskState => {
  const next = parseDesktopTaskState(input.taskState);
  const now = new Date().toISOString();
  const actionResult = input.actionResult;
  if (!actionResult) {
    return next;
  }

  next.updatedAt = now;
  next.latestActionResult = {
    kind: actionResult.kind,
    ok: actionResult.ok,
    summary: summarizeText(actionResult.summary, 400),
    updatedAt: now,
  };

  if (actionResult.kind === 'tool_action' && next.pendingApproval) {
    const resolvedBooksEntity = extractBooksEntityFromActionPayload({
      payload: actionResult.payload,
      fallbackModule: next.pendingApproval.module,
      updatedAt: now,
    });
    const mutationModule = resolvedBooksEntity?.module ?? next.pendingApproval.module;
    const mutationRecordId = resolvedBooksEntity?.recordId ?? next.pendingApproval.recordId;
    next.completedMutations = [
      ...next.completedMutations,
      {
        operation: next.pendingApproval.operation,
        module: mutationModule,
        recordId: mutationRecordId,
        summary: summarizeText(actionResult.summary, 280),
        ok: actionResult.ok,
        updatedAt: now,
      },
    ].slice(-12);

    if (actionResult.ok && mutationModule && mutationRecordId) {
      const entity: DesktopEntityRef = resolvedBooksEntity ?? {
        module: mutationModule,
        recordId: mutationRecordId,
        label: next.currentEntity?.recordId === mutationRecordId ? next.currentEntity.label : undefined,
        updatedAt: now,
      };
      next.currentEntity = entity;
      next.lastFetchedByModule[mutationModule] = entity;
      next.aliases[mutationRecordId] = entity;
      if (entity.label) {
        next.aliases[entity.label.toLowerCase()] = entity;
      }
    }
    next.pendingApproval = null;
  }

  return next;
};

const buildDeterministicSummary = (input: {
  messages: ThreadMessageLike[];
  taskState: DesktopTaskState;
  currentSummary: DesktopThreadSummary;
}): DesktopThreadSummary => {
  const filteredMessages = filterThreadMessagesForContext(input.messages);
  const olderMessages = filteredMessages.slice(0, -THREAD_SUMMARY_RECENT_WINDOW_MESSAGE_COUNT);
  const recentUserGoals = filteredMessages
    .filter((message) => message.role === 'user')
    .map((message) => summarizeText(message.content.trim(), 180))
    .filter(Boolean)
    .slice(-4);

  const activeEntities = mergeUnique(
    input.currentSummary.activeEntities,
    collectActiveEntities(input.taskState),
    8,
  );
  const completedActions = mergeUnique(
    input.currentSummary.completedActions,
    input.taskState.completedMutations.slice(-6).map((mutation) => summarizeText(mutation.summary, 180)),
    10,
  );
  const latestUserGoal = recentUserGoals[recentUserGoals.length - 1]
    ?? input.currentSummary.latestUserGoal
    ?? input.taskState.activeObjective
    ?? input.currentSummary.latestObjective;
  const pendingApprovals = input.taskState.pendingApproval ? [summarizeText(input.taskState.pendingApproval.summary, 180)] : [];
  const constraints = mergeUnique(
    input.currentSummary.constraints,
    input.taskState.activeSourceArtifacts.slice(0, 4).map((artifact) => `Active source artifact: ${artifact.fileName}`),
    8,
  );
  const userGoals = mergeUnique(input.currentSummary.userGoals, recentUserGoals, 8);
  const completedWrites = mergeUnique(
    input.currentSummary.completedWrites,
    input.taskState.completedMutations.filter((mutation) => mutation.ok).slice(-6).map((mutation) => summarizeText(mutation.summary, 180)),
    10,
  );
  const resolvedReferences = mergeUnique(
    input.currentSummary.resolvedReferences,
    Object.values(input.taskState.workingSets)
      .flatMap((workingSet) => Object.entries(workingSet.ordinalMap).slice(0, 6).map(([ordinal, recordId]) =>
        `${ordinal} -> ${workingSet.module}:${recordId}${workingSet.labelsByRecordId[recordId] ? ` (${workingSet.labelsByRecordId[recordId]})` : ''}`)),
    10,
  );
  const latestObjective = input.taskState.activeObjective ?? input.currentSummary.latestObjective;

  return {
    summary: buildDeterministicNarrativeSummary({
      latestObjective,
      latestUserGoal,
      userGoals,
      activeEntities,
      completedActions,
      pendingApprovals,
      constraints,
    }),
    latestObjective,
    latestUserGoal,
    userGoals,
    activeEntities,
    resolvedReferences,
    completedActions,
    completedWrites,
    pendingApprovals,
    constraints,
    sourceMessageCount: input.messages.length,
    updatedAt: new Date().toISOString(),
  };
};

export const shouldRefreshDesktopThreadSummary = (input: {
  messages: ThreadMessageLike[];
  currentSummary: DesktopThreadSummary;
}): boolean => {
  if (input.messages.length < THREAD_SUMMARY_MIN_MESSAGE_COUNT) {
    return false;
  }
  if (input.currentSummary.sourceMessageCount === 0) {
    return true;
  }
  return input.messages.length - input.currentSummary.sourceMessageCount >= THREAD_SUMMARY_REFRESH_DELTA;
};

export const refreshDesktopThreadSummary = async (input: {
  messages: ThreadMessageLike[];
  taskState: DesktopTaskState;
  currentSummary: DesktopThreadSummary;
}): Promise<DesktopThreadSummary> => {
  const deterministic = buildDeterministicSummary(input);
  if (!shouldRefreshDesktopThreadSummary({
    messages: input.messages,
    currentSummary: input.currentSummary,
  })) {
    return deterministic;
  }

  const olderMessages = filterThreadMessagesForContext(input.messages)
    .slice(0, -THREAD_SUMMARY_RECENT_WINDOW_MESSAGE_COUNT)
    .map((message) => ({
    role: message.role,
    content: summarizeText(message.content.trim(), 500),
  }));

  try {
    const model = await resolveVercelLanguageModel('fast');
    const result = await generateObject({
      model: model.model,
      schema: summarySchema,
      system: [
        'Summarize the older portion of an assistant thread into rolling compact memory for future turns.',
        'Keep facts concrete, durable, and machine-usable.',
        'Preserve the high-level summary, current objective, latest user goal, active entities, user goals, resolved object references, completed actions, completed writes, pending approvals, and constraints.',
        'Do not restate greetings, repetitive acknowledgements, or speculative reasoning.',
        'Favor continuity and important operational state over verbatim detail.',
      ].join('\n'),
      prompt: JSON.stringify({
        priorSummary: {
          summary: input.currentSummary.summary,
          latestObjective: input.currentSummary.latestObjective,
          latestUserGoal: input.currentSummary.latestUserGoal,
          userGoals: input.currentSummary.userGoals,
          activeEntities: input.currentSummary.activeEntities,
          resolvedReferences: input.currentSummary.resolvedReferences,
          completedActions: input.currentSummary.completedActions,
          completedWrites: input.currentSummary.completedWrites,
          pendingApprovals: input.currentSummary.pendingApprovals,
          constraints: input.currentSummary.constraints,
        },
        olderMessages,
        taskState: {
          activeObjective: input.taskState.activeObjective,
          activeModule: input.taskState.activeModule,
          currentEntity: input.taskState.currentEntity,
          activeSourceArtifacts: input.taskState.activeSourceArtifacts.slice(0, 4).map((artifact) => artifact.fileName),
          completedMutations: input.taskState.completedMutations.slice(-6),
          pendingApproval: input.taskState.pendingApproval,
        },
      }),
      temperature: 0,
      providerOptions: {
        google: {
          thinkingConfig: {
            includeThoughts: false,
            thinkingLevel: 'minimal',
          },
        },
      },
    });

    return {
      summary: result.object.summary ?? deterministic.summary,
      latestObjective: result.object.latestObjective ?? deterministic.latestObjective,
      latestUserGoal: result.object.latestUserGoal ?? deterministic.latestUserGoal,
      userGoals: result.object.userGoals.length > 0 ? result.object.userGoals : deterministic.userGoals,
      activeEntities: result.object.activeEntities.length > 0 ? result.object.activeEntities : deterministic.activeEntities,
      resolvedReferences: result.object.resolvedReferences.length > 0 ? result.object.resolvedReferences : deterministic.resolvedReferences,
      completedActions: result.object.completedActions.length > 0 ? result.object.completedActions : deterministic.completedActions,
      completedWrites: result.object.completedWrites.length > 0 ? result.object.completedWrites : deterministic.completedWrites,
      pendingApprovals: result.object.pendingApprovals.length > 0 ? result.object.pendingApprovals : deterministic.pendingApprovals,
      constraints: result.object.constraints.length > 0 ? result.object.constraints : deterministic.constraints,
      sourceMessageCount: input.messages.length,
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return deterministic;
  }
};
