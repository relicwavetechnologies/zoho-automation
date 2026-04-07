import { z } from 'zod';

import type {
  CanonicalToolOperation,
  MutationExecutionResult,
  VercelCitation,
  VercelToolEnvelope,
} from '../vercel/types';

export const FALLBACK_SUPERVISOR_AGENT_IDS = [
  'lark-ops-agent',
  'google-workspace-agent',
  'zoho-ops-agent',
  'context-agent',
  'workspace-agent',
] as const;

export type SupervisorAgentId = string;

export const supervisorAgentIdSchema = z.string().min(1).max(120);

export const SUPERVISOR_STEP_ACTIONS = [
  'read_records',
  'search_records',
  'create_task',
  'send_email',
  'create_draft',
  'post_message',
  'update_record',
  'cross_source_lookup',
] as const;

export const SUPERVISOR_SOURCE_SYSTEMS = [
  'zoho_books',
  'zoho_crm',
  'lark',
  'gmail',
  'google_drive',
  'google_calendar',
  'workspace',
  'context',
] as const;

export const supervisorStepActionSchema = z.enum(SUPERVISOR_STEP_ACTIONS);
export const supervisorSourceSystemSchema = z.enum(SUPERVISOR_SOURCE_SYSTEMS);

export const supervisorStepObjectiveSchema = z.object({
  action: supervisorStepActionSchema,
  sourceSystem: supervisorSourceSystemSchema,
  targetEntity: z.string().min(1).optional(),
  targetEntityType: z.enum(['company', 'person', 'record']).nullable().optional(),
  targetSource: z.enum(['books', 'crm', 'files', 'lark', 'web']).nullable().optional(),
  dateRange: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).nullable().optional(),
  fallbackSources: z.array(z.string().min(1)).optional(),
  authorityRequired: z.boolean().optional(),
  naturalLanguage: z.string().min(1).max(1_200),
});

export const supervisorStepSchema = z.object({
  stepId: z.string().min(1).max(80),
  agentId: supervisorAgentIdSchema,
  action: supervisorStepActionSchema,
  sourceSystem: supervisorSourceSystemSchema,
  objective: z.string().min(1).max(1_200),
  structuredObjective: supervisorStepObjectiveSchema.optional(),
  dependsOn: z.array(z.string().min(1).max(80)).max(8).default([]),
  inputRefs: z.array(z.string().min(1).max(80)).max(8).default([]),
});

export const supervisorPlanSchema = z.object({
  complexity: z.enum(['direct', 'single', 'multi']),
  directAnswer: z.string().max(4_000).optional(),
  steps: z.array(supervisorStepSchema).max(8),
});

export type SupervisorStep = z.infer<typeof supervisorStepSchema>;
export type SupervisorPlan = z.infer<typeof supervisorPlanSchema>;
export type SupervisorStepObjective = z.infer<typeof supervisorStepObjectiveSchema>;
export type SupervisorStepAction = z.infer<typeof supervisorStepActionSchema>;
export type SupervisorSourceSystem = z.infer<typeof supervisorSourceSystemSchema>;

export type SupervisorAgentDescriptor = {
  id: string;
  label: string;
  description: string;
  domainIds: string[];
  toolIds: string[];
  systemPrompt?: string;
  modelKey?: string;
  routingHints?: string[];
  isSeeded?: boolean;
};

export type DelegatedToolResult = {
  toolName: string;
  output: VercelToolEnvelope;
};

export type StepArtifact =
  | {
      id: string;
      kind: 'research_summary';
      title: string;
      bodyMarkdown: string;
      citations?: VercelCitation[];
      readyForEmail?: boolean;
    }
  | {
      id: string;
      kind: 'email_draft';
      to?: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      bodyText?: string;
      bodyHtml?: string;
      sourceArtifactIds?: string[];
    }
  | {
      id: string;
      kind: 'contact_resolution';
      name?: string;
      email?: string;
      externalId?: string;
      authorityLevel: 'authoritative' | 'contextual' | 'public';
    }
  | {
      id: string;
      kind: 'message_delivery_result';
      provider: 'gmail' | 'lark';
      operation: 'send' | 'draft';
      messageId?: string;
      threadId?: string;
      success: boolean;
    };

export type StepFailureEnvelope = {
  classification:
    | 'missing_input'
    | 'schema_error'
    | 'resolution_failed'
    | 'tool_refused'
    | 'permission_denied'
    | 'rate_limited'
    | 'not_found'
    | 'ambiguous_request'
    | 'policy_blocked'
    | 'unknown';
  missingFields?: string[];
  missingEntities?: Array<{
    kind: 'person' | 'contact' | 'record' | 'thread' | 'file' | 'id';
    label: string;
  }>;
  attemptedTool?: string;
  attemptedOperation?: string;
  retryable: boolean;
  suggestedRepair?: {
    strategy:
      | 'derive_from_upstream'
      | 'resolve_entity'
      | 'compile_action'
      | 'ask_user'
      | 'switch_tool_mode';
    notes?: string;
  };
  userQuestion?: string;
  rawSummary: string;
};

export type StepRepairHistoryEntry = {
  classification: StepFailureEnvelope['classification'];
  repairedFields: string[];
  resolverToolsUsed: string[];
};

export type StepRepairState = {
  attempts: number;
  seenFailureFingerprints: string[];
  resolvedFields: string[];
  resolverToolsUsed: string[];
  lastClassification?: StepFailureEnvelope['classification'];
};

export type CompiledDelegatedAction =
  | {
      kind: 'send_email';
      provider: 'google';
      to: string[];
      subject: string;
      bodyText?: string;
      bodyHtml?: string;
      sourceArtifactIds: string[];
    }
  | {
      kind: 'create_draft';
      provider: 'google';
      to: string[];
      subject: string;
      bodyText?: string;
      bodyHtml?: string;
      sourceArtifactIds: string[];
    }
  | {
      kind: 'create_task';
      provider: 'lark';
      summary: string;
      description?: string;
      assignee?: { name?: string; openId?: string; userId?: string };
      tasks?: Array<{
        summary: string;
        description?: string;
        assignee?: { name?: string; openId?: string; userId?: string };
      }>;
      sourceArtifactIds: string[];
    }
  | {
      kind: 'post_lark_message';
      provider: 'lark';
      chatId: string;
      text: string;
      sourceArtifactIds: string[];
    };

export type DelegatedStepResult = {
  stepId: string;
  agentId: SupervisorAgentId;
  status: 'success' | 'failed' | 'blocked' | 'approval_required';
  summary: string;
  finalText: string;
  toolEnvelopes: DelegatedToolResult[];
  pendingApprovalAction?: unknown;
  blockingReason?: string | null;
  sourceRefs?: string[];
  sourceArtifacts?: string[];
};

export type StepResultEnvelope = {
  resolvedEntity?: {
    id: string;
    type: string;
    name: string;
    source: string;
    authorityLevel: 'authoritative' | 'documentary' | 'contextual' | 'public';
  };
  resolvedIds: Record<string, string>;
  authorityLevel: 'confirmed' | 'candidate' | 'not_found';
  summary: string;
  artifacts: StepArtifact[];
};

export type DelegatedAgentExecutionResult<TTaskState = unknown> = {
  stepId: string;
  agentId: SupervisorAgentId;
  objective: string;
  status: 'success' | 'failed' | 'partial' | 'blocked' | 'approval_required';
  summary: string;
  assistantText: string;
  text?: string;
  data?: Record<string, unknown>;
  artifacts?: StepArtifact[];
  compiledAction?: CompiledDelegatedAction;
  failure?: StepFailureEnvelope;
  repairAttempts?: number;
  repairHistory?: StepRepairHistoryEntry[];
  toolResults?: Array<{
    toolId?: string;
    toolName: string;
    success: boolean;
    status?: string;
    confirmedAction?: boolean;
    canonicalOperation?: CanonicalToolOperation;
    mutationResult?: MutationExecutionResult;
    pendingApproval?: boolean;
    summary?: string;
    error?: string;
    data?: unknown;
  }>;
  pendingApproval?: unknown;
  pendingApprovalAction?: unknown;
  blockingUserInput?: unknown;
  blockingUserInputPayload?: unknown;
  taskState: TTaskState;
  sourceRefs?: string[];
  output?: Record<string, unknown>;
};

export type SupervisorExecutionResult = {
  stepResults: DelegatedStepResult[];
  haltedBy?: DelegatedStepResult;
  completedStepIds: string[];
  waveCount: number;
};
