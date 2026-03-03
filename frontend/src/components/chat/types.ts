export interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  state?: "call" | "partial-call" | "result";
  result?: unknown;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | string;
  content?: string;
  createdAt?: string | Date;
  toolInvocations?: ToolInvocation[];
}
