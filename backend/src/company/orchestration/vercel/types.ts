import type { ToolActionGroup } from '../../tools/tool-action-groups';

export type VercelToolErrorKind =
  | 'missing_input'
  | 'permission'
  | 'unsupported'
  | 'api_failure'
  | 'validation';

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
    title: string;
    summary: string;
    subject?: string;
    explanation?: string;
    payload: Record<string, unknown>;
  };

export type VercelToolEnvelope = {
  success: boolean;
  summary: string;
  keyData?: Record<string, unknown>;
  fullPayload?: Record<string, unknown>;
  citations?: VercelCitation[];
  errorKind?: VercelToolErrorKind;
  retryable?: boolean;
  userAction?: string;
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
  executionId: string;
  companyId: string;
  userId: string;
  requesterAiRole: string;
  requesterEmail?: string;
  departmentId?: string;
  departmentName?: string;
  departmentRoleSlug?: string;
  larkTenantKey?: string;
  larkOpenId?: string;
  larkUserId?: string;
  authProvider?: string;
  mode: 'fast' | 'high' | 'xtreme';
  workspace?: VercelRuntimeWorkspace;
  dateScope?: string;
  latestActionResult?: {
    kind: string;
    ok: boolean;
    summary: string;
  };
  allowedToolIds: string[];
  allowedActionsByTool?: Record<string, ToolActionGroup[]>;
  departmentSystemPrompt?: string;
  departmentSkillsMarkdown?: string;
};

export type VercelRuntimeToolHooks = {
  onToolStart: (toolName: string, activityId: string, title: string, input?: Record<string, unknown>) => Promise<void>;
  onToolFinish: (toolName: string, activityId: string, title: string, output: VercelToolEnvelope) => Promise<void>;
};
