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

export interface MessageMetadata {
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

/** Live in-flight agentic activity step shown during streaming */
export interface ActivityStep {
  id: string
  name: string
  label: string
  icon: string
  status: 'running' | 'done' | 'error'
  resultSummary?: string
}

export interface StreamEvent {
  type: 'text' | 'thinking' | 'activity' | 'activity_done' | 'step' | 'done' | 'error'
  data: unknown
}

export type AppView = 'login' | 'loading' | 'chat'
