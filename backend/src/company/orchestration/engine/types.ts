import type {
  AgentResultDTO,
  CheckpointDTO,
  ErrorDTO,
  HITLActionDTO,
  NormalizedIncomingMessageDTO,
  OrchestrationTaskDTO,
} from '../../contracts';
import type { OrchestrationTaskStatus } from '../../contracts/status';
import type { CanonicalIntent } from '../intent/canonical-intent';

export type OrchestrationEngineId = 'legacy' | 'vercel' | 'langgraph';

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
    canonicalIntent?: CanonicalIntent;
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
