import type {
  ExecutionActorType,
  ExecutionChannel,
  ExecutionEventItemDTO,
  ExecutionInsightsDTO,
  ExecutionPhase,
  ExecutionRunDetailDTO,
  ExecutionRunFiltersDTO,
  ExecutionRunListItemDTO,
  ExecutionRunStatus,
} from '../../contracts';

export type ExecutionRunScope =
  | { role: 'member'; userId: string; companyId: string }
  | { role: 'admin'; adminRole: 'SUPER_ADMIN' | 'COMPANY_ADMIN'; companyId?: string };

export type StartExecutionRunInput = {
  id?: string;
  companyId: string;
  userId?: string | null;
  channel: ExecutionChannel;
  entrypoint: 'desktop_send' | 'desktop_act' | 'lark_inbound';
  requestId?: string | null;
  taskId?: string | null;
  threadId?: string | null;
  chatId?: string | null;
  messageId?: string | null;
  mode?: 'fast' | 'high' | 'xtreme' | null;
  agentTarget?: string | null;
  latestSummary?: string | null;
};

export type AppendExecutionEventInput = {
  executionId: string;
  phase: ExecutionPhase;
  eventType: string;
  actorType: ExecutionActorType;
  actorKey?: string | null;
  title: string;
  summary?: string | null;
  status?: string | null;
  payload?: Record<string, unknown> | null;
};

export type CompleteExecutionRunInput = {
  executionId: string;
  latestSummary?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type FailExecutionRunInput = {
  executionId: string;
  latestSummary?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type CancelExecutionRunInput = {
  executionId: string;
  latestSummary?: string | null;
};

export type ExecutionRunListResponse = {
  items: ExecutionRunListItemDTO[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    totalRuns: number;
    failedRuns: number;
    activeRuns: number;
    byChannel: Partial<Record<ExecutionChannel, number>>;
    byMode: Partial<Record<'fast' | 'high' | 'xtreme' | 'unknown', number>>;
  };
};

export type ExecutionRunDetailResponse = {
  run: ExecutionRunDetailDTO;
};

export type ExecutionEventListResponse = {
  items: ExecutionEventItemDTO[];
};

export type ExecutionInsightsResponse = ExecutionInsightsDTO;

export type ExecutionRunQuery = ExecutionRunFiltersDTO;

export type ExecutionRunRecord = ExecutionRunListItemDTO | ExecutionRunDetailDTO;

export type ExecutionStatusLike = ExecutionRunStatus;
