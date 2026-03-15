export type ControllerActionKind =
  | 'DISCOVER_CANDIDATES'
  | 'INSPECT_CANDIDATE'
  | 'RETRIEVE_ARTIFACT'
  | 'QUERY_REMOTE_SYSTEM'
  | 'MUTATE_WORKSPACE'
  | 'EXECUTE_COMMAND'
  | 'VERIFY_OUTPUT'
  | 'ASK_USER'
  | 'COMPLETE'
  | 'FAIL';

export type ObjectiveOutputKind =
  | 'direct_reply'
  | 'research_answer'
  | 'remote_artifact'
  | 'workspace_mutation'
  | 'terminal_result'
  | 'remote_entity';

export type VerificationRequirement =
  | 'non_empty_content'
  | 'source_citation'
  | 'workspace_path'
  | 'workspace_content'
  | 'terminal_exit'
  | 'terminal_output'
  | 'entity_evidence';

export type VerificationStatus = 'pending' | 'satisfied' | 'failed';

export type ArtifactRecord = {
  id: string;
  type: string;
  title?: string;
  url?: string;
  metadata?: Record<string, unknown>;
};

export type EntityRecord = {
  type: string;
  id?: string;
  title?: string;
  metadata?: Record<string, unknown>;
};

export type CitationRecord = {
  id: string;
  title: string;
  url?: string;
};

export type VerificationPolicy = {
  outputId: string;
  outputKind: ObjectiveOutputKind;
  description: string;
  requirements: VerificationRequirement[];
};

export type ObjectiveOutput = {
  id: string;
  kind: ObjectiveOutputKind;
  description: string;
  verification: VerificationRequirement[];
  metadata?: Record<string, unknown>;
};

export type ObjectiveContract = {
  objectiveSummary: string;
  successCriteria: string[];
  requestedOutputs: ObjectiveOutput[];
  allowLocalMutation: boolean;
  requiresApproval: boolean;
  blockingQuestions: string[];
  planVisibility: 'hidden' | 'compact' | 'detailed';
  directReply?: string;
  domains: string[];
  notes: string[];
};

export type WorkerCapability = {
  workerKey: string;
  description: string;
  actionKinds: ControllerActionKind[];
  domains: string[];
  artifactTypes: string[];
  canMutateWorkspace: boolean;
  requiresApproval: boolean;
  verificationHints: VerificationRequirement[];
};

export type WorkerInvocation = {
  workerKey: string;
  actionKind: Exclude<ControllerActionKind, 'ASK_USER' | 'COMPLETE' | 'FAIL'>;
  input: Record<string, unknown>;
  reason?: string;
};

export type VerificationResult = {
  outputId: string;
  status: VerificationStatus;
  detail: string;
  evidence: string[];
};

export type ProgressDelta = {
  madeProgress: boolean;
  factsAdded: string[];
  artifactsAdded: string[];
  verificationUpdates: string[];
};

export type WorkerObservation = {
  ok: boolean;
  workerKey: string;
  actionKind: Exclude<ControllerActionKind, 'ASK_USER' | 'COMPLETE' | 'FAIL'>;
  summary: string;
  entities: EntityRecord[];
  facts: string[];
  artifacts: ArtifactRecord[];
  citations: CitationRecord[];
  rawOutput: unknown;
  blockingReason?: string;
  retryHint?: string;
  progressDelta?: ProgressDelta;
  verificationHints: VerificationRequirement[];
};

export type ProgressRecord = {
  step: number;
  actionSignature: string;
  workerKey: string;
  inputHash: string;
  artifactsAdded: string[];
  factsAdded: string[];
  verificationStateChanges: string[];
  blockerClassification?: string;
  madeProgress: boolean;
};

export type ControllerDecision<LocalAction = unknown> =
  | { decision: 'CALL_WORKER'; invocation: WorkerInvocation; reasoning?: string }
  | { decision: 'REQUEST_LOCAL_ACTION'; actionKind: 'MUTATE_WORKSPACE' | 'EXECUTE_COMMAND'; localAction: LocalAction; reasoning?: string }
  | { decision: 'ASK_USER'; question: string }
  | { decision: 'COMPLETE'; reply: string }
  | { decision: 'FAIL'; reason: string };

export type LocalActionPhase = 'running' | 'awaiting_local_action' | 'resuming';

export type LocalActionRecord<LocalAction = unknown> = {
  id: string;
  actionKind: 'MUTATE_WORKSPACE' | 'EXECUTE_COMMAND';
  localAction: LocalAction;
  actionHash: string;
  status: 'pending' | 'succeeded' | 'failed';
  requestedAtStep: number;
  resolvedAtStep?: number;
  observationSummary?: string;
};

export type ControllerRuntimeState<LocalAction = unknown> = {
  executionId: string;
  userRequest: string;
  objective: ObjectiveContract;
  observations: WorkerObservation[];
  progressLedger: ProgressRecord[];
  verifications: VerificationResult[];
  stepCount: number;
  lifecyclePhase: LocalActionPhase;
  localActionHistory: LocalActionRecord<LocalAction>[];
  pendingLocalAction?: {
    id: string;
    actionKind: 'MUTATE_WORKSPACE' | 'EXECUTE_COMMAND';
    localAction: LocalAction;
    actionHash: string;
    summary: string;
    requestedAtStep: number;
  };
};

export type ControllerRuntimeResult<LocalAction = unknown> =
  | { kind: 'action'; action: LocalAction; state: ControllerRuntimeState<LocalAction> }
  | { kind: 'answer'; text: string; state: ControllerRuntimeState<LocalAction> };

export type ControllerRuntimeHooks<LocalAction = unknown, PlanView = unknown> = {
  projectPlan?: (state: ControllerRuntimeState<LocalAction>) => PlanView | null;
  onObjective?: (state: ControllerRuntimeState<LocalAction>, plan: PlanView | null) => Promise<void> | void;
  onDecision?: (state: ControllerRuntimeState<LocalAction>, decision: ControllerDecision<LocalAction>, plan: PlanView | null) => Promise<void> | void;
  onLocalActionRequest?: (
    state: ControllerRuntimeState<LocalAction>,
    decision: Extract<ControllerDecision<LocalAction>, { decision: 'REQUEST_LOCAL_ACTION' }>,
    plan: PlanView | null,
  ) => Promise<void> | void;
  onWorkerStart?: (state: ControllerRuntimeState<LocalAction>, invocation: WorkerInvocation, plan: PlanView | null) => Promise<void> | void;
  onWorkerResult?: (
    state: ControllerRuntimeState<LocalAction>,
    invocation: WorkerInvocation,
    observation: WorkerObservation,
    plan: PlanView | null,
  ) => Promise<void> | void;
  onLocalActionResume?: (
    state: ControllerRuntimeState<LocalAction>,
    observation: WorkerObservation,
    plan: PlanView | null,
  ) => Promise<void> | void;
  onVerification?: (state: ControllerRuntimeState<LocalAction>, plan: PlanView | null) => Promise<void> | void;
  onCheckpoint?: (
    node: string,
    state: ControllerRuntimeState<LocalAction>,
    extra?: Record<string, unknown>,
  ) => Promise<void> | void;
};
