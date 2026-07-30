import { Annotation } from '@langchain/langgraph';
import type { Tool as AppTool } from '../tools/tool.contract';
import type { PermissionResult } from '../../permissions/permission.types';
import type { RunContext } from '../../../domain/orchestration/run-context';
import type { ApprovalGateService } from '../../approval/approval-gate.service';

export interface SupervisorGraphMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface SupervisorGraphDelegation {
  readonly slug: string;
  readonly task: string;
  readonly result: string;
}

export const SupervisorGraphState = Annotation.Root({
  userMessage: Annotation<string>(),
  conversationHistory: Annotation<SupervisorGraphMessage[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  companyId: Annotation<string>(),
  perm: Annotation<PermissionResult>(),
  runContext: Annotation<RunContext>(),
  permittedTools: Annotation<ReadonlyArray<AppTool<unknown, unknown>>>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  chatId: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  memoryContext: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  conversationSummary: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  groupContext: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  inlineImageUrls: Annotation<readonly string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  approvalGate: Annotation<ApprovalGateService | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  supervisorResult: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  toolCallsMade: Annotation<string[]>({
    default: () => [],
    reducer: (prev, next) => [...prev, ...next],
  }),
  agentDelegations: Annotation<SupervisorGraphDelegation[]>({
    default: () => [],
    reducer: (prev, next) => [...prev, ...next],
  }),
  toolResults: Annotation<Array<{ toolName: string; output: string }>>({
    default: () => [],
    reducer: (_prev, next) => next,
  }),
  status: Annotation<'thinking' | 'done' | 'error'>({
    reducer: (_prev, next) => next,
    default: () => 'thinking',
  }),
  error: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

export type SupervisorGraphStateValue = typeof SupervisorGraphState.State;
