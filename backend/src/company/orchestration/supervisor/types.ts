import { z } from 'zod';

import type { VercelToolEnvelope } from '../vercel/types';

export const SUPERVISOR_AGENT_IDS = [
  'lark-ops-agent',
  'google-workspace-agent',
  'zoho-ops-agent',
  'context-agent',
  'workspace-agent',
] as const;

export type SupervisorAgentId = (typeof SUPERVISOR_AGENT_IDS)[number];

export const supervisorAgentIdSchema = z.enum(SUPERVISOR_AGENT_IDS);

export const supervisorStepSchema = z.object({
  stepId: z.string().min(1).max(80),
  agentId: supervisorAgentIdSchema,
  objective: z.string().min(1).max(1_200),
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

export type SupervisorAgentDescriptor = {
  id: SupervisorAgentId;
  label: string;
  description: string;
  domainIds: string[];
  toolIds: string[];
};

export type DelegatedToolResult = {
  toolName: string;
  output: VercelToolEnvelope;
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
};

export type DelegatedAgentExecutionResult<TTaskState = unknown> = {
  stepId: string;
  agentId: SupervisorAgentId;
  objective: string;
  status: 'success' | 'failed' | 'partial';
  summary: string;
  assistantText: string;
  text?: string;
  data?: Record<string, unknown>;
  toolResults?: Array<{
    toolId?: string;
    toolName: string;
    success: boolean;
    status?: string;
    confirmedAction?: boolean;
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
