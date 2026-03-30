import { z } from 'zod';

import {
  scheduledWorkflowDefinitionSchema,
  type ScheduledWorkflowOutputConfig,
  type ScheduledWorkflowScheduleConfig,
  type ScheduledWorkflowSpec,
} from './contracts';

const WORKFLOW_CONVERSATION_LOCAL_PATTERN =
  /\b(latest|last|current|this)\s+(chat|thread|message|conversation|invoice|estimate|record|event|task)\b|\bthat\s+(invoice|estimate|record|event|task)\b/i;
const WORKFLOW_TIMEZONE_AMBIGUOUS_PATTERN = /\b(local time|my time|current time|ist)\b/i;
const HARDCODED_ID_FIELD_PATTERN = /(calendarId|eventId|invoiceId|estimateId|contactId|recordId|taskId|chatId)$/i;
const WORKFLOW_DRAFT_INTAKE_NODE_ID = 'draft_intake';

export const workflowValidationErrorSchema = z.object({
  nodeId: z.string().trim().min(1).max(80),
  toolName: z.string().trim().min(1).max(120),
  field: z.string().trim().min(1).max(160),
  reason: z.enum(['missing_required', 'wrong_type', 'unresolvable_at_runtime', 'circular_dependency']),
  humanReadable: z.string().trim().min(1).max(600),
}).strict();

export const workflowValidationWarningSchema = z.object({
  nodeId: z.string().trim().min(1).max(80),
  toolName: z.string().trim().min(1).max(120),
  field: z.string().trim().min(1).max(160),
  reason: z.enum(['hardcoded_id_may_stale', 'timezone_ambiguous', 'recipient_unverified']),
  humanReadable: z.string().trim().min(1).max(600),
}).strict();

export const workflowValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(workflowValidationErrorSchema).max(100),
  warnings: z.array(workflowValidationWarningSchema).max(100),
}).strict();

export type WorkflowValidationError = z.infer<typeof workflowValidationErrorSchema>;
export type WorkflowValidationWarning = z.infer<typeof workflowValidationWarningSchema>;
export type WorkflowValidationResult = z.infer<typeof workflowValidationResultSchema>;

const readRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const readStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];

const collectStrings = (value: unknown, acc: string[]): void => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      acc.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStrings(entry, acc);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectStrings(entry, acc);
    }
  }
};

const hasAnyStringValue = (value: unknown): boolean => {
  const strings: string[] = [];
  collectStrings(value, strings);
  return strings.length > 0;
};

const getNodeToolName = (
  node: ScheduledWorkflowSpec['nodes'][number],
): string => node.capability?.toolId ?? node.kind;

const pushError = (
  errors: WorkflowValidationError[],
  error: WorkflowValidationError,
) => {
  if (errors.some((entry) =>
    entry.nodeId === error.nodeId
    && entry.toolName === error.toolName
    && entry.field === error.field
    && entry.reason === error.reason
    && entry.humanReadable === error.humanReadable)) {
    return;
  }
  errors.push(error);
};

const pushWarning = (
  warnings: WorkflowValidationWarning[],
  warning: WorkflowValidationWarning,
) => {
  if (warnings.some((entry) =>
    entry.nodeId === warning.nodeId
    && entry.toolName === warning.toolName
    && entry.field === warning.field
    && entry.reason === warning.reason
    && entry.humanReadable === warning.humanReadable)) {
    return;
  }
  warnings.push(warning);
};

const validateCalendarNode = (input: {
  toolName: string;
  node: ScheduledWorkflowSpec['nodes'][number];
  errors: WorkflowValidationError[];
  warnings: WorkflowValidationWarning[];
}): void => {
  const args = readRecord(input.node.toolArguments) ?? {};
  const operation = readString(input.node.capability?.operation) ?? '';
  const nodeId = input.node.id;
  const summary = readString(args.summary);
  const startTime = readString(args.startTime);
  const endTime = readString(args.endTime);
  const eventId = readString(args.eventId);
  const attendeeNames = readStringArray(args.attendeeNames);
  const attendeeIds = readStringArray(args.attendeeIds);
  const searchStartTime = readString(args.searchStartTime);
  const searchEndTime = readString(args.searchEndTime);
  const calendarId = readString(args.calendarId);
  const calendarName = readString(args.calendarName);
  const dateScope = readString(args.dateScope);

  if (operation === 'createEvent') {
    if (!summary) {
      pushError(input.errors, {
        nodeId,
        toolName: input.toolName,
        field: 'summary',
        reason: 'missing_required',
        humanReadable: `Workflow step "${input.node.title}" needs an event title before it can create a calendar event.`,
      });
    }
    if (!startTime) {
      pushError(input.errors, {
        nodeId,
        toolName: input.toolName,
        field: 'startTime',
        reason: 'missing_required',
        humanReadable: `Workflow step "${input.node.title}" needs a concrete start time before it can create a calendar event.`,
      });
    }
    if (!endTime) {
      pushError(input.errors, {
        nodeId,
        toolName: input.toolName,
        field: 'endTime',
        reason: 'missing_required',
        humanReadable: `Workflow step "${input.node.title}" needs a concrete end time before it can create a calendar event.`,
      });
    }
  }

  if (operation === 'scheduleMeeting') {
    if (!summary) {
      pushError(input.errors, {
        nodeId,
        toolName: input.toolName,
        field: 'summary',
        reason: 'missing_required',
        humanReadable: `Workflow step "${input.node.title}" needs a meeting title before it can schedule a meeting.`,
      });
    }
    if (attendeeNames.length === 0 && attendeeIds.length === 0) {
      pushError(input.errors, {
        nodeId,
        toolName: input.toolName,
        field: 'attendeeNames',
        reason: 'missing_required',
        humanReadable: `Workflow step "${input.node.title}" needs attendees before it can schedule a meeting.`,
      });
    }
    if (!searchStartTime && !startTime && !dateScope) {
      pushError(input.errors, {
        nodeId,
        toolName: input.toolName,
        field: 'searchStartTime',
        reason: 'missing_required',
        humanReadable: `Workflow step "${input.node.title}" needs a search window or concrete time before it can schedule a meeting.`,
      });
    }
  }

  if (operation === 'listAvailability') {
    if (attendeeNames.length === 0 && attendeeIds.length === 0) {
      pushError(input.errors, {
        nodeId,
        toolName: input.toolName,
        field: 'attendeeNames',
        reason: 'missing_required',
        humanReadable: `Workflow step "${input.node.title}" needs attendees before it can check availability.`,
      });
    }
    if ((!searchStartTime || !searchEndTime) && !dateScope) {
      pushError(input.errors, {
        nodeId,
        toolName: input.toolName,
        field: 'searchStartTime',
        reason: 'missing_required',
        humanReadable: `Workflow step "${input.node.title}" needs an availability window before it can check calendars.`,
      });
    }
  }

  if (['getEvent', 'updateEvent', 'deleteEvent'].includes(operation) && !eventId) {
    pushError(input.errors, {
      nodeId,
      toolName: input.toolName,
      field: 'eventId',
      reason: 'missing_required',
      humanReadable: `Workflow step "${input.node.title}" needs an event id before it can ${operation}.`,
    });
  }

  if (calendarId && !calendarName) {
    pushWarning(input.warnings, {
      nodeId,
      toolName: input.toolName,
      field: 'calendarId',
      reason: 'hardcoded_id_may_stale',
      humanReadable: `Workflow step "${input.node.title}" uses a hardcoded calendar id. That can go stale if the calendar changes or the workflow is reused elsewhere.`,
    });
  }
};

const validateLarkMessageNode = (input: {
  toolName: string;
  node: ScheduledWorkflowSpec['nodes'][number];
  errors: WorkflowValidationError[];
  warnings: WorkflowValidationWarning[];
}): void => {
  const args = readRecord(input.node.toolArguments) ?? {};
  const operation = readString(input.node.capability?.operation) ?? '';
  if (operation !== 'sendDm') {
    return;
  }
  const nodeId = input.node.id;
  const recipientQueries = readStringArray(args.recipientQueries);
  const recipientOpenIds = readStringArray(args.recipientOpenIds);
  const messageTemplate = readString(args.messageTemplate) ?? readString(args.message) ?? readString(input.node.instructions);
  if (recipientQueries.length === 0 && recipientOpenIds.length === 0) {
    pushError(input.errors, {
      nodeId,
      toolName: input.toolName,
      field: 'recipientQueries',
      reason: 'missing_required',
      humanReadable: `Workflow step "${input.node.title}" needs at least one recipient before it can send a Lark message.`,
    });
  }
  if (!messageTemplate) {
    pushError(input.errors, {
      nodeId,
      toolName: input.toolName,
      field: 'messageTemplate',
      reason: 'missing_required',
      humanReadable: `Workflow step "${input.node.title}" needs a message template before it can send a Lark message.`,
    });
  }
  if (recipientQueries.length > 0 && recipientOpenIds.length === 0) {
    pushWarning(input.warnings, {
      nodeId,
      toolName: input.toolName,
      field: 'recipientQueries',
      reason: 'recipient_unverified',
      humanReadable: `Workflow step "${input.node.title}" still depends on unresolved recipient queries. Confirm the recipients before saving if you want this workflow to send messages reliably.`,
    });
  }
};

const validateConversationLocalDependencies = (input: {
  toolName: string;
  node: ScheduledWorkflowSpec['nodes'][number];
  errors: WorkflowValidationError[];
  warnings: WorkflowValidationWarning[];
}): void => {
  const strings: string[] = [];
  collectStrings(input.node.instructions, strings);
  collectStrings(input.node.toolArguments, strings);
  const joined = strings.join('\n');
  if (joined && WORKFLOW_CONVERSATION_LOCAL_PATTERN.test(joined)) {
    pushError(input.errors, {
      nodeId: input.node.id,
      toolName: input.toolName,
      field: 'instructions',
      reason: 'unresolvable_at_runtime',
      humanReadable: `Workflow step "${input.node.title}" depends on conversation-local context like "latest" or "this chat". Scheduled runs cannot rely on live thread state unless that reference is stored explicitly.`,
    });
  }
  if (joined && WORKFLOW_TIMEZONE_AMBIGUOUS_PATTERN.test(joined)) {
    pushWarning(input.warnings, {
      nodeId: input.node.id,
      toolName: input.toolName,
      field: 'instructions',
      reason: 'timezone_ambiguous',
      humanReadable: `Workflow step "${input.node.title}" refers to an ambiguous time zone or local time phrasing. Make the time zone explicit before saving if you need predictable timing.`,
    });
  }
};

const validateHardcodedIds = (input: {
  toolName: string;
  node: ScheduledWorkflowSpec['nodes'][number];
  warnings: WorkflowValidationWarning[];
}): void => {
  const args = readRecord(input.node.toolArguments) ?? {};
  for (const [key, value] of Object.entries(args)) {
    if (!HARDCODED_ID_FIELD_PATTERN.test(key)) {
      continue;
    }
    if (!readString(value)) {
      continue;
    }
    pushWarning(input.warnings, {
      nodeId: input.node.id,
      toolName: input.toolName,
      field: key,
      reason: 'hardcoded_id_may_stale',
      humanReadable: `Workflow step "${input.node.title}" uses a hardcoded ${key}. If the referenced record changes later, this workflow may fail or act on the wrong target.`,
    });
  }
};

const validateDestinations = (input: {
  outputConfig: ScheduledWorkflowOutputConfig;
  originChatId?: string | null;
  errors: WorkflowValidationError[];
}): void => {
  if (input.outputConfig.destinations.length === 0) {
    pushError(input.errors, {
      nodeId: 'workflow_output',
      toolName: 'delivery',
      field: 'outputConfig.destinations',
      reason: 'missing_required',
      humanReadable: 'This workflow has no delivery destinations configured yet. Choose where results should be delivered before saving.',
    });
  }
  const hasCurrentLarkChat = input.outputConfig.destinations.some(
    (destination) => destination.kind === 'lark_current_chat',
  );
  if (hasCurrentLarkChat && !readString(input.originChatId ?? null)) {
    pushError(input.errors, {
      nodeId: 'workflow_output',
      toolName: 'delivery',
      field: 'originChatId',
      reason: 'missing_required',
      humanReadable: 'This workflow is configured to send results back to the current Lark chat, but the source chat id is missing. Recreate or save it from the intended Lark chat.',
    });
  }
  const hasSelfLarkDmWithoutOpenId = input.outputConfig.destinations.some(
    (destination) => destination.kind === 'lark_self_dm' && !readString(destination.openId),
  );
  if (hasSelfLarkDmWithoutOpenId) {
    pushError(input.errors, {
      nodeId: 'workflow_output',
      toolName: 'delivery',
      field: 'outputConfig.destinations.openId',
      reason: 'missing_required',
      humanReadable: 'This workflow is configured to send results to the requester\'s personal Lark DM, but the requester Lark open id is missing.',
    });
  }
};

const zodIssueToReason = (message: string): WorkflowValidationError['reason'] => {
  if (/acyclic|cycle/i.test(message)) {
    return 'circular_dependency';
  }
  if (/required|missing|unknown delivery destination/i.test(message)) {
    return 'missing_required';
  }
  return 'wrong_type';
};

export const validateScheduledWorkflowDefinition = (input: {
  userIntent: string;
  workflowSpec: ScheduledWorkflowSpec;
  schedule: ScheduledWorkflowScheduleConfig;
  outputConfig: ScheduledWorkflowOutputConfig;
  originChatId?: string | null;
}): WorkflowValidationResult => {
  const errors: WorkflowValidationError[] = [];
  const warnings: WorkflowValidationWarning[] = [];

  const parsed = scheduledWorkflowDefinitionSchema.safeParse({
    userIntent: input.userIntent,
    workflowSpec: input.workflowSpec,
    schedule: input.schedule,
    outputConfig: input.outputConfig,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const nodeId = issue.path[1] && typeof issue.path[1] === 'number'
        ? readString(input.workflowSpec.nodes[issue.path[1] as number]?.id) ?? 'workflow'
        : 'workflow';
      const toolName = nodeId === 'workflow'
        ? 'workflow'
        : getNodeToolName(input.workflowSpec.nodes.find((node) => node.id === nodeId) ?? input.workflowSpec.nodes[0]!);
      pushError(errors, {
        nodeId,
        toolName,
        field: issue.path.map((entry) => String(entry)).join('.') || 'workflow',
        reason: zodIssueToReason(issue.message),
        humanReadable: issue.message,
      });
    }
  }

  validateDestinations({
    outputConfig: input.outputConfig,
    originChatId: input.originChatId,
    errors,
  });

  if (
    input.workflowSpec.nodes.length === 1
    && input.workflowSpec.nodes[0]?.id === WORKFLOW_DRAFT_INTAKE_NODE_ID
  ) {
    pushError(errors, {
      nodeId: WORKFLOW_DRAFT_INTAKE_NODE_ID,
      toolName: 'workflow',
      field: 'workflowSpec.nodes',
      reason: 'missing_required',
      humanReadable: 'This workflow is still a draft intake placeholder. Generate a real execution map before publishing or scheduling it.',
    });
  }

  for (const node of input.workflowSpec.nodes) {
    const toolName = getNodeToolName(node);
    validateConversationLocalDependencies({ toolName, node, errors, warnings });
    validateHardcodedIds({ toolName, node, warnings });

    const normalizedToolId = toolName.toLowerCase();
    if (
      normalizedToolId === 'larkcalendar'
      || normalizedToolId === 'lark-calendar-write'
      || normalizedToolId === 'lark-calendar-agent'
    ) {
      validateCalendarNode({ toolName, node, errors, warnings });
      continue;
    }
    if (
      normalizedToolId === 'googlecalendar'
      || normalizedToolId === 'google-calendar'
    ) {
      validateCalendarNode({ toolName, node, errors, warnings });
      continue;
    }
    if (
      normalizedToolId === 'larkmessage'
      || normalizedToolId === 'lark-message-write'
    ) {
      validateLarkMessageNode({ toolName, node, errors, warnings });
      continue;
    }
    if (node.kind === 'deliver' && !(node.destinationIds && node.destinationIds.length > 0)) {
      pushError(errors, {
        nodeId: node.id,
        toolName,
        field: 'destinationIds',
        reason: 'missing_required',
        humanReadable: `Workflow step "${node.title}" needs at least one delivery destination.`,
      });
    }
    if (node.capability && !hasAnyStringValue(node.toolArguments) && !readString(node.instructions)) {
      pushError(errors, {
        nodeId: node.id,
        toolName,
        field: 'instructions',
        reason: 'missing_required',
        humanReadable: `Workflow step "${node.title}" needs concrete instructions or tool arguments before it can run reliably.`,
      });
    }
  }

  return workflowValidationResultSchema.parse({
    valid: errors.length === 0,
    errors,
    warnings,
  });
};

export const workflowValidatorService = {
  validateDefinition: validateScheduledWorkflowDefinition,
};
