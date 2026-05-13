/**
 * Typed orchestration event definitions.
 *
 * Each event has:
 *   phase:     coarse lifecycle stage (init / plan / execute / synthesis / audit)
 *   eventType: the specific event name
 *   actorType: who emitted it (engine / supervisor / specialist / executor / tool)
 *   payload:   strongly typed data (stripped of sensitive keys before storage)
 *
 * These mirror the old backend's OrchestrationEventPayloadMap but are
 * designed for the advance-backend's simpler, flatter architecture.
 */

// ─── Phases ──────────────────────────────────────────────────────────────────

export type RunPhase =
  | 'init'
  | 'permission'
  | 'routing'
  | 'plan'
  | 'execute'
  | 'synthesis'
  | 'complete'
  | 'error';

// ─── Actor types ──────────────────────────────────────────────────────────────

export type ActorType =
  | 'engine'
  | 'supervisor'
  | 'specialist'
  | 'executor'
  | 'tool'
  | 'mem0'
  | 'synthesis';

// ─── Event type literals ──────────────────────────────────────────────────────

export type RunEventType =
  | 'run_started'
  | 'permission_resolved'
  | 'permission_denied'
  | 'routing_decided'
  | 'specialist_started'
  | 'plan_created'
  | 'plan_failed'
  | 'step_executed'
  | 'step_failed'
  | 'specialist_complete'
  | 'redelegate_to_general'
  | 'synthesis_complete'
  | 'synthesis_failed'
  | 'run_complete'
  | 'run_failed'
  | 'supervisor_started'
  | 'tool_call_started'
  | 'tool_call_finished'
  | 'supervisor_complete'
  | 'memory_extracted';

// ─── Payload shapes (one per event type) ────────────────────────────────────

export interface RunStartedPayload {
  userMessageLength: number;
  channel:           string;
  companyId:         string;
  userId:            string;
}

export interface PermissionResolvedPayload {
  allowedToolCount: number;
  hasDepartment:    boolean;
}

export interface PermissionDeniedPayload {
  reason: string;
}

export interface RoutingDecidedPayload {
  domain:     string;
  childAgent: string | null;
  toolCount:  number;
}

export interface SpecialistStartedPayload {
  domain:         string;
  scopedToolIds:  string[];
  scopedToolCount: number;
}

export interface PlanCreatedPayload {
  intent:     string;
  stepCount:  number;
  stepIds:    string[];
  toolIds:    string[];
}

export interface PlanFailedPayload {
  reason: string;
}

export interface StepExecutedPayload {
  stepId:      string;
  agentId:     string;
  status:      string;
  durationMs:  number;
  toolIds:     string[];
  successCount: number;
  failCount:   number;
  summary?:    string;
}

export interface StepFailedPayload {
  stepId:  string;
  reason:  string;
}

export interface SpecialistCompletePayload {
  domain:       string;
  confidence:   string;
  stepCount:    number;
  failedTools:  string[];
  missingTools: string[];
}

export interface RedelegatePayload {
  originalDomain: string;
  reason:         string;
}

export interface SynthesisCompletePayload {
  replyLength:   number;
  replyPreview?: string;
}

export interface SynthesisFailedPayload {
  reason: string;
}

export interface RunCompletePayload {
  stepCount:       number;
  toolOutcomeCount: number;
  replyLength:     number;
  durationMs:      number;
  toolsCalled?:    string[];
}

export interface SupervisorStartedPayload {
  toolCount: number;
}

export interface ToolCallStartedPayload {
  toolName: string;
  args:     unknown;
}

export interface ToolCallFinishedPayload {
  toolName:      string;
  resultLength:  number;
  resultPreview?: string;
  error?:        string;
}

export interface SupervisorCompletePayload {
  toolsCalled:   string[];
  replyLength:   number;
  replyPreview?: string;
}

export interface MemoryExtractedPayload {
  userId:          string;
  attemptedScopes: string[];
  storedMemories:  number;
  scopes:          Array<{ scope: string; count: number }>;
}

export interface RunFailedPayload {
  stage:  string;
  reason: string;
}

// ─── Union ────────────────────────────────────────────────────────────────────

export type RunEventPayload =
  | RunStartedPayload
  | PermissionResolvedPayload
  | PermissionDeniedPayload
  | RoutingDecidedPayload
  | SpecialistStartedPayload
  | PlanCreatedPayload
  | PlanFailedPayload
  | StepExecutedPayload
  | StepFailedPayload
  | SpecialistCompletePayload
  | RedelegatePayload
  | SynthesisCompletePayload
  | SynthesisFailedPayload
  | RunCompletePayload
  | RunFailedPayload
  | SupervisorStartedPayload
  | ToolCallStartedPayload
  | ToolCallFinishedPayload
  | SupervisorCompletePayload
  | MemoryExtractedPayload;

// ─── Emit input ──────────────────────────────────────────────────────────────

export interface EmitEventInput {
  phase:     RunPhase;
  eventType: RunEventType;
  actorType: ActorType;
  title:     string;
  summary?:  string;
  status?:   'success' | 'warning' | 'error' | 'info';
  actorKey?: string;
  payload?:  RunEventPayload;
}
