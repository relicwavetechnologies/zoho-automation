export interface DepartmentSummary {
  id: string
  name: string
  slug: string
  roleId: string
  roleSlug: string
  roleName: string
  canManage: boolean
}

export interface UserSession {
  userId: string
  companyId: string
  name?: string
  email: string
  role: string
  aiRole?: string
  sessionId: string
  expiresAt: string
  authProvider: 'password' | 'handoff' | 'lark'
  larkTenantKey?: string
  larkOpenId?: string
  larkUserId?: string
  departments?: DepartmentSummary[]
  resolvedDepartmentId?: string
  resolvedDepartmentName?: string
  resolvedDepartmentRoleSlug?: string
}

export interface WorkspaceFolder {
  id: string
  path: string
  name: string
}

export interface Thread {
  id: string
  title: string | null
  departmentId?: string | null
  department?: {
    id: string
    name: string
    slug: string
  } | null
  lastMessageAt: string | null
  createdAt: string
  updatedAt: string
  messageCount?: number
  larkDocs?: LarkDocRef[]
}

export interface Message {
  id: string
  threadId: string
  role: 'user' | 'assistant'
  content: string
  metadata?: MessageMetadata
  createdAt: string
}

export interface ThreadMessagePagination {
  hasMoreOlder: boolean
  nextBeforeMessageId: string | null
  limit: number
}

export interface ThreadMessagesPage {
  thread: Thread
  messages: Message[]
  pagination: ThreadMessagePagination
}

// ─── Content Blocks — unified ordered timeline ────────────────────────────────

export interface ToolContentBlock {
  type: 'tool'
  id: string
  name: string
  label: string
  icon: string
  status: 'running' | 'done' | 'failed'
  resultSummary?: string
}

export interface ApprovalContentBlock {
  type: 'approval'
  id: string
  kind: 'run_command' | 'write_file' | 'mkdir' | 'delete_path'
  title: string
  description: string
  subject: string
  footer: string
  status: 'pending' | 'approved' | 'rejected'
}

export interface TerminalContentBlock {
  type: 'terminal'
  id: string
  command: string
  cwd: string
  status: 'running' | 'done' | 'failed'
  stdout: string
  stderr: string
  exitCode?: number | null
  signal?: string | null
  durationMs?: number
}

export interface TextContentBlock {
  type: 'text'
  content: string
}

export interface ThinkingContentBlock {
  type: 'thinking'
  /** Duration in milliseconds (set when the thinking period is finalized) */
  durationMs?: number
  /** Optional internal reasoning text (populated when model exposes it) */
  text?: string
}

export type ContentBlock =
  | ToolContentBlock
  | ApprovalContentBlock
  | TerminalContentBlock
  | TextContentBlock
  | ThinkingContentBlock

export type ExecutionPlanTaskStatus = 'pending' | 'running' | 'done' | 'blocked' | 'failed' | 'skipped'
export type ExecutionPlanStatus = 'running' | 'completed' | 'failed'
export type ExecutionPlanOwnerAgent =
  | 'supervisor'
  | 'zoho'
  | 'outreach'
  | 'search'
  | 'larkBase'
  | 'larkTask'
  | 'larkCalendar'
  | 'larkMeeting'
  | 'larkApproval'
  | 'larkDoc'
  | 'workspace'
  | 'terminal'
export type ExecutionChannel = 'desktop' | 'lark'
export type ExecutionMode = 'fast' | 'high' | 'xtreme' | null
export type ExecutionRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export type ExecutionPhase = 'request' | 'planning' | 'tool' | 'synthesis' | 'delivery' | 'error' | 'control'
export type ExecutionActorType = 'system' | 'planner' | 'agent' | 'tool' | 'model' | 'delivery'

export interface ExecutionPlanTask {
  id: string
  title: string
  ownerAgent: ExecutionPlanOwnerAgent
  status: ExecutionPlanTaskStatus
  resultSummary?: string
}

export interface ExecutionPlan {
  id: string
  goal: string
  successCriteria: string[]
  status: ExecutionPlanStatus
  createdAt: string
  updatedAt: string
  tasks: ExecutionPlanTask[]
}

export interface ExecutionRunSummary {
  id: string
  companyId: string
  companyName: string | null
  userId: string | null
  userName: string | null
  userEmail: string | null
  channel: ExecutionChannel
  entrypoint: string
  requestId: string | null
  taskId: string | null
  threadId: string | null
  chatId: string | null
  messageId: string | null
  mode: ExecutionMode
  agentTarget: string | null
  status: ExecutionRunStatus
  latestSummary: string | null
  errorCode: string | null
  errorMessage: string | null
  eventCount: number
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
}

export interface ExecutionEventItem {
  id: string
  executionId: string
  sequence: number
  phase: ExecutionPhase
  eventType: string
  actorType: ExecutionActorType
  actorKey: string | null
  title: string
  summary: string | null
  status: string | null
  payload: Record<string, unknown> | null
  createdAt: string
}

// ─── Message metadata ─────────────────────────────────────────────────────────
export interface MessageMetadata {
  contentBlocks?: ContentBlock[]
  plan?: ExecutionPlan
  executionId?: string
  executionState?: {
    state: 'running' | 'waiting_for_approval' | 'running_after_approval' | 'completed' | 'failed' | 'cancelled'
    paused?: boolean
    resumeOfExecutionId?: string
  }
  taskStateSnapshot?: Record<string, unknown>
  threadSummarySnapshot?: Record<string, unknown>
  desktopPendingAction?: {
    kind: 'list_files' | 'read_file' | 'write_file' | 'mkdir' | 'delete_path' | 'run_command' | 'tool_action'
    approvalId?: string
    toolId?: string
    actionGroup?: 'read' | 'create' | 'update' | 'delete' | 'send' | 'execute'
    operation?: string
    title?: string
    summary?: string
    subject?: string
    explanation?: string
    path?: string
    content?: string
    command?: string
  }
  attachedFiles?: Array<{ fileAssetId: string; cloudinaryUrl: string; mimeType: string; fileName: string }>
  shareAction?: {
    type: 'conversation'
    conversationKey: string
    label: string
    shared?: boolean
  }
  citations?: Array<{
    id: string
    title: string
    url?: string
    kind?: string
    sourceType?: string
    sourceId?: string
    fileAssetId?: string
    chunkIndex?: number
  }>
  /** Legacy — kept for backward compat */
  toolCalls?: ToolCallInfo[]
  larkDocs?: LarkDocRef[]
  localCommandSummary?: {
    command: string
    cwd: string
    status: 'done' | 'failed' | 'rejected'
    exitCode?: number | null
    durationMs?: number
  }
  localFileSummary?: {
    kind: 'list_files' | 'read_file' | 'write_file' | 'mkdir' | 'delete_path'
    path: string
    status: 'done' | 'failed' | 'rejected'
  }
  error?: string
  streaming?: boolean
}

export interface ToolCallInfo {
  id: string
  name: string
  label: string
  icon: string
  status: 'running' | 'completed' | 'failed'
  result?: string
}

export interface LarkDocRef {
  title: string
  documentId: string
  url: string
  updatedAtMs: number
}

export interface StreamEvent {
  type: 'text' | 'thinking' | 'thinking_token' | 'activity' | 'activity_done' | 'action' | 'step' | 'plan' | 'done' | 'error'
  data: unknown
}

export type AppView = 'login' | 'loading' | 'chat'
