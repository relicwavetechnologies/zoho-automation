export interface UserSession {
  userId: string
  companyId: string
  name?: string
  email: string
  role: string
  sessionId: string
  expiresAt: string
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

export type ContentBlock = ToolContentBlock | TextContentBlock | ThinkingContentBlock

// ─── Message metadata ─────────────────────────────────────────────────────────
export interface MessageMetadata {
  contentBlocks?: ContentBlock[]
  /** Legacy — kept for backward compat */
  toolCalls?: ToolCallInfo[]
  larkDocs?: LarkDocRef[]
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
  type: 'text' | 'thinking' | 'activity' | 'activity_done' | 'step' | 'done' | 'error'
  data: unknown
}

export type AppView = 'login' | 'loading' | 'chat'
