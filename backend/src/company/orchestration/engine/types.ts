import type {
  AgentResultDTO,
  CheckpointDTO,
  ErrorDTO,
  HITLActionDTO,
  NormalizedIncomingMessageDTO,
  OrchestrationTaskDTO,
} from '../../contracts';
import type { OrchestrationTaskStatus } from '../../contracts/status';

export type OrchestrationEngineId = 'legacy' | 'langgraph';

export type RollbackReasonCode =
  | 'llm_unavailable'
  | 'llm_invalid_output'
  | 'checkpoint_io'
  | 'agent_runtime'
  | 'unknown'
  | 'non_eligible';

export type RollbackDecision = {
  eligible: boolean;
  reasonCode: RollbackReasonCode;
};

export type OrchestrationExecutionResult = {
  task: OrchestrationTaskDTO;
  status: OrchestrationTaskStatus;
  currentStep?: string;
  latestSynthesis?: string;
  agentResults?: AgentResultDTO[];
  hitlAction?: HITLActionDTO;
  runtimeMeta?: {
    engine: OrchestrationEngineId;
    threadId?: string;
    node?: string;
    stepHistory?: string[];
    routeIntent?: string;
  };
  errors?: ErrorDTO[];
};

export type OrchestrationExecutionInput = {
  task: OrchestrationTaskDTO;
  message: NormalizedIncomingMessageDTO;
  latestCheckpoint?: CheckpointDTO | null;
};

export interface OrchestrationEngine {
  readonly id: OrchestrationEngineId;
  buildTask(taskId: string, message: NormalizedIncomingMessageDTO): Promise<OrchestrationTaskDTO>;
  executeTask(input: OrchestrationExecutionInput): Promise<OrchestrationExecutionResult>;
}
