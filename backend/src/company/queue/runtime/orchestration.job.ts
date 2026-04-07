import type { NormalizedIncomingMessageDTO } from '../../contracts';

export const ORCHESTRATION_JOB_NAME = 'orchestration.task.execute' as const;

export type OrchestrationJobData = {
  taskId: string;
  message: NormalizedIncomingMessageDTO;
};

export type OrchestrationJobLike = {
  id?: string | number;
  name: typeof ORCHESTRATION_JOB_NAME;
  data: OrchestrationJobData;
};
