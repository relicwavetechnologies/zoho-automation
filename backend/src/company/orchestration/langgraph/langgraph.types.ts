import type {
  AgentInvokeInputDTO,
  AgentResultDTO,
  ErrorDTO,
  HITLActionDTO,
  NormalizedIncomingMessageDTO,
  OrchestrationTaskDTO,
} from '../../contracts';
import type { OrchestrationTaskStatus } from '../../contracts/status';

export type LangGraphRouteState = {
  intent: 'zoho_read' | 'write_intent' | 'general';
  complexityLevel: 1 | 2 | 3 | 4 | 5;
  executionMode: 'sequential' | 'parallel' | 'mixed';
};

export type LangGraphSynthesisState = {
  text: string;
  taskStatus: OrchestrationTaskStatus;
};

export type LangGraphRuntimeMeta = {
  engine: 'langgraph';
  threadId: string;
  node: string;
  stepHistory: string[];
  routeIntent?: string;
  retryCount?: number;
};

export type LangGraphState = {
  task: OrchestrationTaskDTO;
  message: NormalizedIncomingMessageDTO;
  route: LangGraphRouteState;
  plan: string[];
  agentInvocations: AgentInvokeInputDTO[];
  agentResults: AgentResultDTO[];
  hitl?: HITLActionDTO;
  synthesis?: LangGraphSynthesisState;
  runtimeMeta: LangGraphRuntimeMeta;
  errors: ErrorDTO[];
  finalStatus?: OrchestrationTaskStatus;
};
