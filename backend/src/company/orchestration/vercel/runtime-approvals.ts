import { logger } from '../../../utils/logger';
import { getSupportedToolActionGroups, type ToolActionGroup } from '../../tools/tool-action-groups';
import { ALIAS_TO_CANONICAL_ID, getToolPolicyDescriptor, type ToolPolicyDescriptor } from '../../tools/tool-registry';
import { toCanonicalToolId, type CanonicalToolId } from '../../tools/canonical-tool-id';
import type {
  CanonicalToolOperation,
  MutationExecutionResult,
  VercelRuntimeRequestContext,
  VercelToolEnvelope,
} from './types';
import type { RemoteDesktopLocalAction } from './tools/families/coding.shared';

export const buildWorkflowValidationRepairHints = (
  entries: Array<Record<string, unknown>>,
  asString: (value: unknown) => string | undefined,
): Record<string, string> =>
  Object.fromEntries(
    entries
      .map((entry, index) => {
        const nodeId = asString(entry.nodeId)?.trim();
        const field = asString(entry.field)?.trim();
        const humanReadable =
          asString(entry.humanReadable)?.trim()
          ?? asString(entry.message)?.trim()
          ?? asString(entry.reason)?.trim();
        if (!humanReadable) {
          return null;
        }
        const key = nodeId || field || `issue_${index + 1}`;
        return [key, humanReadable] as const;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry)),
  );

export const buildBooksWriteRepairHints = (fields: string[]): Record<string, string> => {
  const hints: Record<string, string> = {
    module:
      'Provide the Zoho Books module, or call booksRead first to load the target module context.',
    recordId:
      'Call booksRead for the target module first to get the recordId, then retry the mutation.',
    body:
      'Provide the mutation payload in body, or reuse the pending write body from the current thread.',
    accountId: 'Call booksRead with module=bankaccounts to get the accountId first.',
    transactionId:
      'Call booksRead with module=banktransactions to get the transactionId first.',
    invoiceId: 'Call booksRead with module=invoices to get the invoiceId first.',
    estimateId: 'Call booksRead with module=estimates to get the estimateId first.',
    creditNoteId: 'Call booksRead with module=creditnotes to get the creditNoteId first.',
    salesOrderId: 'Call booksRead with module=salesorders to get the salesOrderId first.',
    purchaseOrderId:
      'Call booksRead with module=purchaseorders to get the purchaseOrderId first.',
    billId: 'Call booksRead with module=bills to get the billId first.',
    contactId: 'Call booksRead with module=contacts to get the contactId first.',
    vendorPaymentId:
      'Call booksRead with module=vendorpayments to get the vendorPaymentId first.',
    commentId: 'List the record comments first to get the commentId, then retry.',
    templateId: 'List Zoho Books templates for the target module first to get the templateId.',
    fileName: 'Provide a filename for the attachment upload.',
    contentBase64: 'Provide the attachment contents as base64.',
  };

  return Object.fromEntries(fields.flatMap((field) => (hints[field] ? [[field, hints[field]]] : [])));
};

export const getAllowedActionGroups = (
  runtime: VercelRuntimeRequestContext,
  toolId: string,
): ToolActionGroup[] => {
  const normalizedToolId = toolId.trim();
  const canonicalToolId = ALIAS_TO_CANONICAL_ID[normalizedToolId] ?? normalizedToolId;
  const explicit =
    runtime.allowedActionsByTool?.[canonicalToolId]
    ?? runtime.allowedActionsByTool?.[normalizedToolId];
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  const allowedViaCanonical = runtime.allowedToolIds.includes(canonicalToolId);
  const allowedViaLegacy = runtime.allowedToolIds.includes(normalizedToolId);
  if (allowedViaCanonical || allowedViaLegacy) {
    return getSupportedToolActionGroups(canonicalToolId);
  }
  return [];
};

export const resolveToolPolicyDescriptor = (toolId: string): ToolPolicyDescriptor =>
  getToolPolicyDescriptor(toolId);

export const requiresIntrinsicApproval = (
  toolId: string,
  actionGroup?: ToolActionGroup,
): boolean => {
  if (!actionGroup) {
    return false;
  }
  return resolveToolPolicyDescriptor(toolId).intrinsicApprovalActionGroups.includes(actionGroup);
};

export const ensureActionPermission = (
  runtime: VercelRuntimeRequestContext,
  toolId: CanonicalToolId,
  actionGroup: ToolActionGroup,
  buildEnvelope: (payload: Record<string, unknown>) => VercelToolEnvelope,
): VercelToolEnvelope | null => {
  const canonicalToolId = toCanonicalToolId(toolId);
  const normalizedToolId = toolId.trim();
  const allowedActions = runtime.allowedActionsByTool?.[canonicalToolId]
    ?? runtime.allowedActionsByTool?.[normalizedToolId];
  const allowed = getAllowedActionGroups(runtime, toolId);
  const isAllowed = allowed.includes(actionGroup);
  logger.info('tool.permission.check', {
    toolId,
    canonicalToolId,
    actionGroup,
    allowed: isAllowed,
    foundInAllowedActions: Boolean(allowedActions),
    allowedActionsForTool: allowedActions ?? null,
    allowedToolIds: runtime.allowedToolIds,
    verdict: isAllowed ? 'PASS' : 'DENY',
  });
  if (isAllowed) {
    return null;
  }
  return buildEnvelope({
    success: false,
    summary: `Permission denied: ${toolId} cannot perform ${actionGroup} for the current department role.`,
    errorKind: 'permission',
    retryable: false,
  });
};

export const ensureAnyActionPermission = (
  runtime: VercelRuntimeRequestContext,
  toolIds: CanonicalToolId[],
  actionGroup: ToolActionGroup,
  buildEnvelope: (payload: Record<string, unknown>) => VercelToolEnvelope,
  label?: string,
): VercelToolEnvelope | null => {
  const normalizedToolIds = Array.from(new Set(toolIds.filter(Boolean)));
  const allowed = normalizedToolIds.some((toolId) =>
    getAllowedActionGroups(runtime, toolId).includes(actionGroup),
  );
  if (allowed) {
    return null;
  }
  return buildEnvelope({
    success: false,
    summary: `Permission denied: ${label ?? normalizedToolIds.join(', ')} cannot perform ${actionGroup} for the current department role.`,
    errorKind: 'permission',
    retryable: false,
  });
};

const isRequesterResolvedApprover = async (
  runtime: VercelRuntimeRequestContext,
  deps: {
    loadDepartmentService: () => {
      resolveDepartmentApprover: (input: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  },
): Promise<boolean> => {
  if (runtime.departmentRoleSlug?.trim().toUpperCase() === 'MANAGER') {
    return true;
  }
  const approver = await deps.loadDepartmentService().resolveDepartmentApprover({
    companyId: runtime.companyId,
    departmentId: runtime.departmentId,
  });
  if (!approver) {
    return false;
  }
  if (runtime.userId && approver.userId === runtime.userId) {
    return true;
  }
  if (runtime.larkOpenId && approver.larkOpenId && approver.larkOpenId === runtime.larkOpenId) {
    return true;
  }
  const requesterEmail = runtime.requesterEmail?.trim().toLowerCase();
  const approverEmail = approver.email?.trim().toLowerCase();
  return Boolean(requesterEmail && approverEmail && requesterEmail === approverEmail);
};

const buildImmediateApprovalExecutionEnvelope = (input: {
  ok: boolean;
  summary: string;
  toolId?: string;
  actionGroup?: ToolActionGroup;
  operation?: string;
  canonicalOperation?: CanonicalToolOperation;
  mutationResult?: MutationExecutionResult;
  payload?: Record<string, unknown>;
  errorKind?: VercelToolEnvelope['errorKind'];
  buildEnvelope: (payload: Record<string, unknown>) => VercelToolEnvelope;
}): VercelToolEnvelope =>
  input.buildEnvelope({
    success: input.ok,
    summary: input.summary,
    toolId: input.toolId,
    actionGroup: input.actionGroup,
    confirmedAction:
      input.ok && Boolean(input.actionGroup && input.actionGroup !== 'read'),
    operation: input.operation,
    canonicalOperation: input.canonicalOperation,
    mutationResult: input.mutationResult,
    keyData: input.payload,
    fullPayload: input.payload,
    ...(input.ok
      ? {}
      : {
          errorKind: input.errorKind ?? 'api_failure',
          retryable: false,
        }),
  });

export const createPendingRemoteApproval = async (input: {
  runtime: VercelRuntimeRequestContext;
  toolId: string;
  actionGroup: ToolActionGroup;
  operation: string;
  canonicalOperation?: CanonicalToolOperation;
  summary: string;
  subject?: string;
  explanation?: string;
  payload: Record<string, unknown>;
  buildEnvelope: (payload: Record<string, unknown>) => VercelToolEnvelope;
  loadHitlActionService: () => any;
  loadExecuteStoredRemoteToolAction: () => (action: any) => Promise<any>;
  loadDepartmentService: () => {
    resolveDepartmentApprover: (input: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  };
}): Promise<VercelToolEnvelope> => {
  const actionType =
    input.actionGroup === 'delete'
      ? 'delete'
      : input.actionGroup === 'execute' || input.actionGroup === 'send'
        ? 'execute'
        : input.actionGroup === 'update'
          ? 'update'
          : 'write';
  const hitlActionService = input.loadHitlActionService();
  const shouldBypassApproval = await isRequesterResolvedApprover(input.runtime, {
    loadDepartmentService: input.loadDepartmentService,
  });
  const pending = await hitlActionService.createPending({
    taskId: input.runtime.executionId,
    actionType,
    summary: input.summary,
    chatId: input.runtime.chatId ?? input.runtime.threadId,
    threadId: input.runtime.threadId,
    executionId: input.runtime.executionId,
    channel: input.runtime.channel,
    toolId: input.toolId,
    actionGroup: input.actionGroup,
    subject: input.subject,
    payload: {
      ...input.payload,
      toolId: input.toolId,
      actionGroup: input.actionGroup,
      operation: input.operation,
      ...(input.canonicalOperation ? { canonicalOperation: input.canonicalOperation } : {}),
    },
    metadata: {
      companyId: input.runtime.companyId,
      userId: input.runtime.userId,
      requesterAiRole: input.runtime.requesterAiRole,
      requesterEmail: input.runtime.requesterEmail,
      departmentId: input.runtime.departmentId,
      departmentName: input.runtime.departmentName,
      departmentRoleSlug: input.runtime.departmentRoleSlug,
      departmentManagerApprovalConfig: input.runtime.departmentManagerApprovalConfig,
      authProvider: input.runtime.authProvider,
      larkTenantKey: input.runtime.larkTenantKey,
      larkOpenId: input.runtime.larkOpenId,
      larkUserId: input.runtime.larkUserId,
      sourceMessageId: input.runtime.sourceMessageId,
      sourceReplyToMessageId: input.runtime.sourceReplyToMessageId,
      sourceStatusMessageId: input.runtime.sourceStatusMessageId,
      sourceStatusReplyModeHint: input.runtime.sourceStatusReplyModeHint,
      sourceChatType: input.runtime.sourceChatType,
      sourceChannelUserId: input.runtime.sourceChannelUserId,
      mode: input.runtime.mode,
    },
  });
  if (shouldBypassApproval) {
    try {
      await hitlActionService.resolveByActionId(pending.actionId, 'confirmed');
      const storedAction = await hitlActionService.getStoredAction(pending.actionId);
      if (!storedAction) {
        return buildImmediateApprovalExecutionEnvelope({
          ok: false,
          summary: 'Failed to execute the approved action because the stored approval record could not be found.',
          errorKind: 'api_failure',
          buildEnvelope: input.buildEnvelope,
        });
      }
      const executionResult = await input.loadExecuteStoredRemoteToolAction()(storedAction);
      return buildImmediateApprovalExecutionEnvelope({
        ok: executionResult.ok,
        summary: executionResult.summary,
        toolId: input.toolId,
        actionGroup: input.actionGroup,
        operation: input.operation,
        canonicalOperation: executionResult.canonicalOperation ?? input.canonicalOperation,
        mutationResult: executionResult.mutationResult,
        payload: executionResult.payload,
        errorKind: executionResult.ok ? undefined : 'api_failure',
        buildEnvelope: input.buildEnvelope,
      });
    } catch (error) {
      return buildImmediateApprovalExecutionEnvelope({
        ok: false,
        summary: error instanceof Error ? error.message : 'Failed to execute the approved action.',
        toolId: input.toolId,
        actionGroup: input.actionGroup,
        operation: input.operation,
        canonicalOperation: input.canonicalOperation,
        mutationResult: {
          attempted: true,
          succeeded: false,
          provider: input.canonicalOperation?.provider ?? input.toolId,
          operation: input.canonicalOperation?.operation ?? input.operation,
          pendingApproval: false,
          errorKind: 'api_failure',
          error: error instanceof Error ? error.message : 'Failed to execute the approved action.',
        },
        errorKind: 'api_failure',
        buildEnvelope: input.buildEnvelope,
      });
    }
  }
  return input.buildEnvelope({
    toolId: input.toolId,
    actionGroup: input.actionGroup,
    operation: input.operation,
    status: 'skipped',
    confirmedAction: false,
    success: true,
    summary: input.summary,
    pendingApprovalAction: {
      kind: 'tool_action',
      approvalId: pending.actionId,
      scope: 'backend_remote',
      toolId: input.toolId,
      actionGroup: input.actionGroup,
      operation: input.operation,
      canonicalOperation: input.canonicalOperation,
      title: `${input.toolId} ${input.actionGroup} approval required`,
      summary: input.summary,
      subject: input.subject,
      explanation: input.explanation,
      payload: input.payload,
    },
  });
};

export const createPendingDesktopRemoteApproval = async (input: {
  runtime: VercelRuntimeRequestContext;
  action: RemoteDesktopLocalAction;
  actionGroup: ToolActionGroup;
  operation: string;
  summary: string;
  subject?: string;
  explanation?: string;
  buildEnvelope: (payload: Record<string, unknown>) => VercelToolEnvelope;
  loadHitlActionService: () => any;
  loadDepartmentService: () => {
    resolveDepartmentApprover: (input: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  };
  loadDesktopWsGateway: () => {
    dispatchRemoteLocalAction: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
}): Promise<VercelToolEnvelope> => {
  if (await isRequesterResolvedApprover(input.runtime, {
    loadDepartmentService: input.loadDepartmentService,
  })) {
    try {
      const gateway = input.loadDesktopWsGateway();
      const result = await gateway.dispatchRemoteLocalAction({
        userId: input.runtime.userId,
        companyId: input.runtime.companyId,
        action: input.action,
        reason: input.explanation,
        overrideAsk: true,
      });
      return buildImmediateApprovalExecutionEnvelope({
        ok: result.ok,
        summary: result.summary,
        toolId: 'coding',
        actionGroup: input.actionGroup,
        operation: input.operation,
        payload: result.payload,
        errorKind: result.ok ? undefined : 'api_failure',
        buildEnvelope: input.buildEnvelope,
      });
    } catch (error) {
      return buildImmediateApprovalExecutionEnvelope({
        ok: false,
        summary: error instanceof Error ? error.message : 'Failed to execute the approved desktop action.',
        toolId: 'coding',
        actionGroup: input.actionGroup,
        operation: input.operation,
        errorKind: 'api_failure',
        buildEnvelope: input.buildEnvelope,
      });
    }
  }
  const actionType =
    input.actionGroup === 'delete'
      ? 'delete'
      : input.actionGroup === 'execute'
        ? 'execute'
        : input.actionGroup === 'update'
          ? 'update'
          : 'write';
  const pending = await input.loadHitlActionService().createPending({
    taskId: input.runtime.executionId,
    actionType,
    summary: input.summary,
    chatId: input.runtime.chatId ?? input.runtime.threadId,
    threadId: input.runtime.threadId,
    executionId: input.runtime.executionId,
    channel: input.runtime.channel,
    toolId: 'coding',
    actionGroup: input.actionGroup,
    subject: input.subject,
    payload: {
      toolId: 'coding',
      actionGroup: input.actionGroup,
      operation: input.operation,
      desktopRemoteLocalAction: input.action,
    },
    metadata: {
      companyId: input.runtime.companyId,
      userId: input.runtime.userId,
      requesterAiRole: input.runtime.requesterAiRole,
      requesterEmail: input.runtime.requesterEmail,
      departmentId: input.runtime.departmentId,
      departmentName: input.runtime.departmentName,
      departmentRoleSlug: input.runtime.departmentRoleSlug,
      authProvider: input.runtime.authProvider,
      larkTenantKey: input.runtime.larkTenantKey,
      larkOpenId: input.runtime.larkOpenId,
      larkUserId: input.runtime.larkUserId,
      sourceMessageId: input.runtime.sourceMessageId,
      sourceReplyToMessageId: input.runtime.sourceReplyToMessageId,
      sourceStatusMessageId: input.runtime.sourceStatusMessageId,
      sourceStatusReplyModeHint: input.runtime.sourceStatusReplyModeHint,
      sourceChatType: input.runtime.sourceChatType,
      sourceChannelUserId: input.runtime.sourceChannelUserId,
      mode: input.runtime.mode,
      desktopRemoteLocalAction: input.action,
      desktopRemoteLocalActionGroup: input.actionGroup,
      desktopRemoteLocalOperation: input.operation,
      desktopRemoteLocalSummary: input.summary,
      ...(input.explanation ? { desktopRemoteLocalExplanation: input.explanation } : {}),
      approvalExecutionMode: 'desktop_remote',
    },
  });
  return input.buildEnvelope({
    success: true,
    summary: input.summary,
    pendingApprovalAction: {
      kind: 'tool_action',
      approvalId: pending.actionId,
      scope: 'backend_remote',
      toolId: 'coding',
      actionGroup: input.actionGroup,
      operation: input.operation,
      title: 'Desktop execution approval required',
      summary: input.summary,
      subject: input.subject,
      explanation: input.explanation,
      payload: {
        desktopRemoteLocalAction: input.action,
      },
    },
  });
};
