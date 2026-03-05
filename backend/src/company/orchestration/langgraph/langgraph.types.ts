import type {
  AgentInvokeInputDTO,
  AgentResultDTO,
  ErrorDTO,
  HITLActionDTO,
  NormalizedIncomingMessageDTO,
  OrchestrationTaskDTO,
} from '../../contracts';
import type { OrchestrationTaskStatus } from '../../contracts/status';

export type LangGraphRouteSource = 'llm' | 'heuristic_fallback';
export type LangGraphRouteFallbackReasonCode =
  | 'llm_empty'
  | 'llm_non_json'
  | 'llm_invalid_enum'
  | 'llm_invalid_range';

export type LangGraphPlanSource = 'llm' | 'fallback';
export type LangGraphSynthesisSource = 'llm' | 'deterministic_fallback';
export type LangGraphResponseDeliveryStatus = 'sent' | 'skipped' | 'failed';

export type LangGraphRouteState = {
  intent: 'zoho_read' | 'write_intent' | 'general';
  complexityLevel: 1 | 2 | 3 | 4 | 5;
  executionMode: 'sequential' | 'parallel' | 'mixed';
  source?: LangGraphRouteSource;
  fallbackReasonCode?: LangGraphRouteFallbackReasonCode;
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
  planSource?: LangGraphPlanSource;
  planValidationErrors?: string[];
  agentInvocations: AgentInvokeInputDTO[];
  agentResults: AgentResultDTO[];
  hitl?: HITLActionDTO;
  synthesis?: LangGraphSynthesisState;
  synthesisSource?: LangGraphSynthesisSource;
  responseDeliveryStatus?: LangGraphResponseDeliveryStatus;
  runtimeMeta: LangGraphRuntimeMeta;
  errors: ErrorDTO[];
  finalStatus?: OrchestrationTaskStatus;
};
