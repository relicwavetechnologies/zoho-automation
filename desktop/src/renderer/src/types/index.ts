export interface UserSession {
  userId: string
  companyId: string
  name?: string
  email: string
  role: string
  sessionId: string
  expiresAt: string
  authProvider: 'password' | 'handoff' | 'lark'
  larkTenantKey?: string
  larkOpenId?: string
  larkUserId?: string
}

export interface WorkspaceFolder {
  id: string
  path: string
  name: string
}

export interface Thread {
  id: string
  title: string | null
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

// ─── Message metadata ─────────────────────────────────────────────────────────
export interface MessageMetadata {
  contentBlocks?: ContentBlock[]
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
  type: 'text' | 'thinking' | 'thinking_token' | 'activity' | 'activity_done' | 'step' | 'done' | 'error'
  data: unknown
}

export type AppView = 'login' | 'loading' | 'chat'
