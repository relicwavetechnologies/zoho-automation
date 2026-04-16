import type { ToolActionGroup } from '../../tools/tool-action-groups';
import type { ZohoRateLimitConfig } from '../../integrations/zoho/zoho-rate-limit.types';
import type { DepartmentManagerApprovalConfig } from '../../departments/department.service';
import type { CompanyPromptProfileRuntime } from '../../prompt-profiles/company-prompt-profile.cache';
import type { SearchIntent } from '../search-intent-classifier';
import type { CanonicalIntent } from '../intent/canonical-intent';
import type { AgentDefinition } from '../../../generated/prisma';

export type VercelToolErrorKind =
  | 'missing_input'
  | 'permission'
  | 'unsupported'
  | 'api_failure'
  | 'validation'
  | 'not_found'
  | 'resolution_failed'
  | 'rate_limited'
  | 'policy_blocked';

export type VercelToolResultStatus =
  | 'success'
  | 'error'
  | 'empty'
  | 'timeout'
  | 'skipped';

export type VercelCitation = {
  id: string;
  title: string;
  url?: string;
  kind?: string;
  sourceType?: string;
  sourceId?: string;
  fileAssetId?: string;
  chunkIndex?: number;
};

export type CanonicalToolOperation = {
  provider: 'google' | 'lark' | 'zoho';
  product: 'gmail' | 'drive' | 'calendar' | 'message' | 'books' | 'crm';
  operation: string;
  actionGroup: 'read' | 'create' | 'update' | 'delete' | 'send' | 'execute';
};

export type MutationExecutionResult = {
  attempted: boolean;
  succeeded: boolean;
  provider: string;
  operation: string;
  entityId?: string;
  messageId?: string;
  threadId?: string;
  pendingApproval: boolean;
  errorKind?: string;
  error?: string;
};

export type PendingApprovalAction =
  | {
      kind: 'run_command';
      approvalId?: string;
      scope?: 'local_client';
      toolId?: string;
      actionGroup?: ToolActionGroup;
      title?: string;
      subject?: string;
      command: string;
      cwd?: string;
      explanation?: string;
    }
  | {
      kind: 'write_file';
      approvalId?: string;
      scope?: 'local_client';
      toolId?: string;
      actionGroup?: ToolActionGroup;
      title?: string;
      subject?: string;
      path: string;
      content: string;
      explanation?: string;
    }
  | {
      kind: 'create_directory';
      approvalId?: string;
      scope?: 'local_client';
      toolId?: string;
      actionGroup?: ToolActionGroup;
      title?: string;
      subject?: string;
      path: string;
      explanation?: string;
    }
  | {
      kind: 'delete_path';
      approvalId?: string;
      scope?: 'local_client';
      toolId?: string;
      actionGroup?: ToolActionGroup;
      title?: string;
      subject?: string;
      path: string;
      explanation?: string;
    }
  | {
      kind: 'tool_action';
      approvalId: string;
      scope: 'backend_remote';
      toolId: string;
      actionGroup: ToolActionGroup;
      operation: string;
      canonicalOperation?: CanonicalToolOperation;
      title: string;
      summary: string;
      subject?: string;
      explanation?: string;
      payload: Record<string, unknown>;
    };

export type VercelToolEnvelope = {
  toolId: string;
  status: VercelToolResultStatus;
  data: unknown;
  confirmedAction: boolean;
  success: boolean;
  summary: string;
  actionGroup?: ToolActionGroup;
  operation?: string;
  canonicalOperation?: CanonicalToolOperation;
  mutationResult?: MutationExecutionResult;
  keyData?: Record<string, unknown>;
  fullPayload?: Record<string, unknown>;
  citations?: VercelCitation[];
  errorKind?: VercelToolErrorKind;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  userAction?: string;
  missingFields?: string[];
  repairHints?: Record<string, string>;
  pendingApprovalAction?: PendingApprovalAction;
};

export type VercelRuntimeWorkspace = {
  name: string;
  path: string;
};

export type VercelRuntimeRequestContext = {
  channel?: 'desktop' | 'lark';
  threadId: string;
  chatId?: string;
  attachedFiles?: Array<{
    fileAssetId: string;
    cloudinaryUrl: string;
    mimeType: string;
    fileName: string;
  }>;
  executionId: string;
  companyId: string;
  userId: string;
  requesterChannelIdentityId?: string;
  requesterAiRole: string;
  requesterName?: string;
  requesterEmail?: string;
  sourceMessageId?: string;
  sourceReplyToMessageId?: string;
  sourceStatusMessageId?: string;
  sourceStatusReplyModeHint?: 'thread' | 'reply' | 'plain' | 'dm';
  sourceChatType?: 'p2p' | 'group';
  sourceChannelUserId?: string;
  latestUserMessage?: string;
  departmentId?: string;
  departmentName?: string;
  departmentRoleId?: string;
  departmentRoleSlug?: string;
  departmentZohoReadScope?: 'personalized' | 'show_all';
  departmentZohoRateLimitConfig?: ZohoRateLimitConfig;
  departmentManagerApprovalConfig?: DepartmentManagerApprovalConfig;
  larkTenantKey?: string;
  larkOpenId?: string;
  larkUserId?: string;
  authProvider?: string;
  mode: 'fast' | 'high';
  workspace?: VercelRuntimeWorkspace;
  desktopExecutionAvailability?: 'available' | 'none' | 'ambiguous';
  desktopApprovalPolicySummary?: string;
  dateScope?: string;
  taskState?: {
    activeDomain?: string;
    activeModule?: string;
    currentWorkflowId?: string;
    currentEntity?: {
      module: string;
      recordId: string;
      label?: string;
      updatedAt?: string;
    };
    lastFetchedByModule?: Record<
      string,
      {
        module: string;
        recordId: string;
        label?: string;
        updatedAt?: string;
      }
    >;
    pendingApproval?: {
      toolId: string;
      actionGroup?: string;
      operation: string;
      module?: string;
      recordId?: string;
      payload?: Record<string, unknown>;
      updatedAt?: string;
    } | null;
  };
  latestActionResult?: {
    kind: string;
    ok: boolean;
    summary: string;
  };
  allowedToolIds: string[];
  runExposedToolIds?: string[];
  plannerCandidateToolIds?: string[];
  toolSelectionReason?: string;
  toolSelectionFallbackNeeded?: boolean;
  plannerChosenToolId?: string;
  plannerChosenOperationClass?: string;
  allowedActionsByTool?: Record<string, ToolActionGroup[]>;
  companyPromptProfile?: CompanyPromptProfileRuntime;
  departmentSystemPrompt?: string;
  departmentSkillsMarkdown?: string;
  agentDefinition?: Pick<AgentDefinition, 'id' | 'name' | 'description' | 'systemPrompt' | 'toolIds' | 'isActive' | 'modelId' | 'provider'>;
  childAgentDefinitions?: Map<string, Pick<AgentDefinition, 'id' | 'name' | 'systemPrompt' | 'toolIds' | 'modelId' | 'provider'>> | undefined;
  searchIntent?: SearchIntent;
  searchIntentPromise?: Promise<SearchIntent>;
  canonicalIntent?: CanonicalIntent;
  canonicalIntentPromise?: Promise<CanonicalIntent>;
  delegatedAgentId?: string;
};

export type VercelRuntimeToolHooks = {
  onToolStart: (
    toolName: string,
    activityId: string,
    title: string,
    input?: Record<string, unknown>,
  ) => Promise<void>;
  onToolFinish: (
    toolName: string,
    activityId: string,
    title: string,
    output: VercelToolEnvelope,
  ) => Promise<void>;
};
