import type {
  AgentInvokeInputDTO,
  AgentResultDTO,
  CheckpointDTO,
  HITLActionDTO,
  NormalizedIncomingMessageDTO,
  OrchestrationTaskDTO,
} from './dto';
import type { OrchestrationTaskStatus } from './status';

export const ORCHESTRATION_EVENT_TYPES = {
  ingressAccepted: 'orchestration.ingress.accepted',
  taskQueued: 'orchestration.task.queued',
  taskStatusChanged: 'orchestration.task.status_changed',
  agentInvocationRequested: 'orchestration.agent.invocation_requested',
  agentResultRecorded: 'orchestration.agent.result_recorded',
  checkpointSaved: 'orchestration.checkpoint.saved',
  hitlRequested: 'orchestration.hitl.requested',
  hitlResolved: 'orchestration.hitl.resolved',
} as const;

export type OrchestrationEventType =
  (typeof ORCHESTRATION_EVENT_TYPES)[keyof typeof ORCHESTRATION_EVENT_TYPES];

export type OrchestrationEventPayloadMap = {
  [ORCHESTRATION_EVENT_TYPES.ingressAccepted]: {
    message: NormalizedIncomingMessageDTO;
  };
  [ORCHESTRATION_EVENT_TYPES.taskQueued]: {
    task: OrchestrationTaskDTO;
  };
  [ORCHESTRATION_EVENT_TYPES.taskStatusChanged]: {
    taskId: string;
    messageId: string;
    from: OrchestrationTaskStatus;
    to: OrchestrationTaskStatus;
    changedAt: string;
  };
  [ORCHESTRATION_EVENT_TYPES.agentInvocationRequested]: {
    input: AgentInvokeInputDTO;
  };
  [ORCHESTRATION_EVENT_TYPES.agentResultRecorded]: {
    result: AgentResultDTO;
    recordedAt: string;
  };
  [ORCHESTRATION_EVENT_TYPES.checkpointSaved]: {
    checkpoint: CheckpointDTO;
  };
  [ORCHESTRATION_EVENT_TYPES.hitlRequested]: {
    action: HITLActionDTO;
  };
  [ORCHESTRATION_EVENT_TYPES.hitlResolved]: {
    action: HITLActionDTO;
    resolvedAt: string;
  };
};

export type OrchestrationEvent<T extends OrchestrationEventType = OrchestrationEventType> = {
  type: T;
  taskId: string;
  messageId: string;
  occurredAt: string;
  payload: OrchestrationEventPayloadMap[T];
};
