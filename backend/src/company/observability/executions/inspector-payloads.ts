import type { ModelMessage } from 'ai';

const clampText = (value: string | null | undefined, maxLength = 4000): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
};

const toPlainText = (value: unknown, maxLength = 2000): string | null => {
  if (value == null) return null;
  if (typeof value === 'string') return clampText(value, maxLength);
  try {
    return clampText(JSON.stringify(value, null, 2), maxLength);
  } catch {
    return clampText(String(value), maxLength);
  }
};

const flattenMessageContent = (content: ModelMessage['content'] | string | undefined): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      return typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('\n');
};

export const buildExecutionRequestPayload = (input: {
  originalPrompt: string;
  channel: 'desktop' | 'lark';
  threadId?: string | null;
  chatId?: string | null;
  messageId?: string | null;
  taskId?: string | null;
  linkedUserId?: string | null;
}): Record<string, unknown> => ({
  requestSummary: {
    originalPromptPreview: clampText(input.originalPrompt, 320),
    channel: input.channel,
    threadId: input.threadId ?? null,
    chatId: input.chatId ?? null,
    messageId: input.messageId ?? null,
    taskId: input.taskId ?? null,
  },
  requestContext: {
    originalPrompt: clampText(input.originalPrompt, 12_000),
    linkedUserId: input.linkedUserId ?? null,
    threadId: input.threadId ?? null,
    chatId: input.chatId ?? null,
    messageId: input.messageId ?? null,
    taskId: input.taskId ?? null,
  },
});

export const buildExecutionModelInputPayload = (input: {
  label: string;
  systemPrompt: string;
  messages: ModelMessage[];
  contextSummary?: Record<string, unknown> | null;
  toolAvailability?: Record<string, unknown> | null;
}): Record<string, unknown> => {
  const normalizedMessages = input.messages.map((message, index) => ({
    index,
    role: message.role,
    content: clampText(flattenMessageContent(message.content), 4000),
  }));

  return {
    modelInputSummary: {
      label: input.label,
      messageCount: normalizedMessages.length,
      systemPromptLength: input.systemPrompt.length,
      contextSummary: input.contextSummary ?? null,
      toolAvailability: input.toolAvailability ?? null,
    },
    modelInput: {
      label: input.label,
      systemPrompt: clampText(input.systemPrompt, 20_000),
      messages: normalizedMessages,
      contextSummary: input.contextSummary ?? null,
      toolAvailability: input.toolAvailability ?? null,
    },
  };
};

export const buildExecutionToolCallPayload = (input: {
  toolName: string;
  title: string;
  toolInput?: unknown;
  sourceContext?: unknown;
}): Record<string, unknown> => ({
  toolCallSummary: {
    toolName: input.toolName,
    title: input.title,
    hasToolInput: input.toolInput != null,
    hasSourceContext: input.sourceContext != null,
  },
  toolCall: {
    toolName: input.toolName,
    title: input.title,
    toolInput: input.toolInput ?? null,
    sourceContext: input.sourceContext ?? null,
  },
});

export const buildExecutionToolResultPayload = (input: {
  toolName: string;
  title: string;
  success: boolean;
  summary?: string | null;
  status?: string | null;
  pendingApprovalAction?: unknown;
  output?: unknown;
  latencyMs?: number | null;
  error?: unknown;
}): Record<string, unknown> => ({
  toolResultSummary: {
    toolName: input.toolName,
    title: input.title,
    success: input.success,
    status: input.status ?? null,
    summary: clampText(input.summary ?? null, 1000),
    latencyMs: input.latencyMs ?? null,
    pendingApproval: Boolean(input.pendingApprovalAction),
  },
  toolResult: {
    toolName: input.toolName,
    title: input.title,
    success: input.success,
    status: input.status ?? null,
    summary: clampText(input.summary ?? null, 4000),
    latencyMs: input.latencyMs ?? null,
    pendingApprovalAction: input.pendingApprovalAction ?? null,
    resultExcerpt: toPlainText(input.output, 5000),
    error: input.error ?? null,
  },
});

export const buildExecutionDecisionPayload = (input: {
  summary: string;
  details?: Record<string, unknown> | null;
}): Record<string, unknown> => ({
  decisionState: {
    summary: clampText(input.summary, 2000),
    details: input.details ?? null,
  },
});

export const buildExecutionFailurePayload = (input: {
  stage: string;
  errorMessage: string;
  errorCode?: string | null;
  details?: Record<string, unknown> | null;
}): Record<string, unknown> => ({
  failureDetail: {
    stage: input.stage,
    errorCode: input.errorCode ?? null,
    errorMessage: clampText(input.errorMessage, 5000),
    details: input.details ?? null,
  },
});

export const buildExecutionOutcomePayload = (input: {
  finalText: string;
  deliveryTarget?: string | null;
  details?: Record<string, unknown> | null;
}): Record<string, unknown> => ({
  finalOutcome: {
    finalText: clampText(input.finalText, 12_000),
    deliveryTarget: input.deliveryTarget ?? null,
    details: input.details ?? null,
  },
});
