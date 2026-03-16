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

export type VerificationRequirement =
  | 'non_empty_content'
  | 'source_citation'
  | 'workspace_path'
  | 'workspace_content'
  | 'terminal_exit'
  | 'terminal_output'
  | 'entity_evidence'
  | 'skill_metadata'
  | 'skill_document';

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

export type SkillMetadata = {
  id: string;
  name: string;
  description: string;
  whenToUse: string[];
  tags: string[];
  toolHints: string[];
};

export type SkillDocument = SkillMetadata & {
  content: string;
};

export type ControllerTaskProfile = {
  summary: string;
  complexity: 'ambient' | 'simple' | 'structured';
  shouldUseSkills: boolean;
  skillQuery?: string;
  deliverables: string[];
  missingInputs: string[];
  directReply?: string;
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
  checkId: string;
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
  actionKind?: Exclude<ControllerActionKind, 'ASK_USER' | 'COMPLETE' | 'FAIL'>;
  inputHash: string;
  artifactsAdded: string[];
  factsAdded: string[];
  verificationStateChanges: string[];
  blockerClassification?: string;
  madeProgress: boolean;
};

export type ControllerDecision<LocalAction = unknown> =
  | { decision: 'CALL_WORKER'; invocation: WorkerInvocation; reasoning?: string }
  | { decision: 'SET_TODOS'; requiredTools: string[]; reasoning?: string }
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

export type TodoItemStatus = 'pending' | 'running' | 'done' | 'failed';
export type TodoMode = 'read' | 'write' | 'verify';

export type TodoItem = {
  key: string;
  tool: string;
  mode: TodoMode;
  label: string;
  status: TodoItemStatus;
  lastSummary?: string;
};

export type TodoListState = {
  required: string[];
  completed: string[];
  failed: string[];
  retryCounts: Record<string, number>;
  items: TodoItem[];
  currentTool?: string | null;
  initialized: boolean;
} | null;

export type WorkerResultDTO = {
  hopIndex: number;
  workerKey: string;
  actionKind: string;
  input: Record<string, unknown>;
  success: boolean;
  hasSubstantiveContent: boolean;
  summary: string;
  keyData: Record<string, unknown>;
  fullPayload: string;
  timestamp: number;
  error?: string;
};

export type ControllerRuntimeState<LocalAction = unknown> = {
  executionId: string;
  userRequest: string;
  profile: ControllerTaskProfile;
  bootstrap?: ControllerTaskProfile;
  inferredInputs?: Record<string, string | undefined>;
  readinessConfirmed: boolean;
  scopeExpanded?: boolean;
  todoList?: TodoListState;
  terminalEventEmitted?: boolean;
  observations: WorkerObservation[];
  workerResults: WorkerResultDTO[];
  progressLedger: ProgressRecord[];
  verifications: VerificationResult[];
  stepCount: number;
  hopCount: number;
  retryCount: number;
  lifecyclePhase: LocalActionPhase;
  localActionHistory: LocalActionRecord<LocalAction>[];
  pendingSkillId?: string | null;
  resolvedSkillId?: string | null;
  loadedSkillContent?: string | null;
  availableSkills?: SkillMetadata[];
  lastAction?: {
    workerKey: string;
    actionKind: Exclude<ControllerActionKind, 'ASK_USER' | 'COMPLETE' | 'FAIL'>;
    success: boolean;
  } | null;
  lastContractViolation?: string | null;
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
  | {
    kind: 'answer';
    text: string;
    terminalState: 'COMPLETE' | 'ASK_USER' | 'FAIL' | 'UNKNOWN';
    state: ControllerRuntimeState<LocalAction>;
  };

export type ControllerRuntimeHooks<LocalAction = unknown, PlanView = unknown> = {
  projectPlan?: (state: ControllerRuntimeState<LocalAction>) => PlanView | null;
  onBootstrap?: (state: ControllerRuntimeState<LocalAction>, plan: PlanView | null) => Promise<void> | void;
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
