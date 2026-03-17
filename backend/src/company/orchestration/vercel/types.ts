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
    command: string;
    cwd?: string;
    explanation?: string;
  }
  | {
    kind: 'write_file';
    path: string;
    content: string;
    explanation?: string;
  }
  | {
    kind: 'create_directory';
    path: string;
    explanation?: string;
  }
  | {
    kind: 'delete_path';
    path: string;
    explanation?: string;
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
  threadId: string;
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
  departmentSystemPrompt?: string;
  departmentSkillsMarkdown?: string;
};

export type VercelRuntimeToolHooks = {
  onToolStart: (toolName: string, activityId: string, title: string, input?: Record<string, unknown>) => Promise<void>;
  onToolFinish: (toolName: string, activityId: string, title: string, output: VercelToolEnvelope) => Promise<void>;
};
