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
  type: 'text' | 'step' | 'tool' | 'done' | 'error'
  data: string
}

export type AppView = 'login' | 'loading' | 'chat'
