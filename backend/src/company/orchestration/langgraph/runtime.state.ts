import type { ToolActionGroup } from '../../tools/tool-action-groups';
import type {
  RuntimeActor,
  RuntimeChannel,
  RuntimeClassificationResult,
  RuntimeConversationRefs,
  RuntimeConversationStatus,
  RuntimeDiagnostics,
  RuntimeDeliveryEnvelope,
  RuntimeEvidenceItem,
  RuntimeExecutionStepState,
  RuntimeMessageRecord,
  RuntimePermissions,
  RuntimeParityReport,
  RuntimeRetrievalDecision,
  RuntimeRunEntrypoint,
} from './runtime.types';
import { createEmptyRuntimeDiagnostics } from './runtime.loop-guards';

export type RuntimeState = {
  version: 1;
  run: {
    id: string;
    mode: 'primary' | 'shadow';
    channel: RuntimeChannel;
    entrypoint: RuntimeRunEntrypoint;
    currentNode: string;
    stepIndex: number;
    maxSteps: number;
    stopReason?: string;
  };
  conversation: {
    id: string;
    key: string;
    rawChannelKey: string;
    companyId: string;
    departmentId?: string;
    status: RuntimeConversationStatus;
  };
  actor: RuntimeActor;
  permissions: RuntimePermissions;
  prompt: {
    baseSystemPrompt: string;
    departmentName?: string;
    departmentRoleSlug?: string;
    departmentPrompt?: string;
    skillsMarkdown?: string;
    channelInstructions: string;
    dateScope?: string;
  };
  history: {
    messages: RuntimeMessageRecord[];
    refs: RuntimeConversationRefs;
  };
  approval?: {
    pendingApprovalId: string;
    status: 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'executed';
    toolId: string;
    actionGroup: Extract<ToolActionGroup, 'create' | 'update' | 'delete' | 'send' | 'execute'>;
  };
  delivery: {
    statusMessageId?: string;
    finalMessageId?: string;
    sentDedupeKeys: string[];
    outbox: RuntimeDeliveryEnvelope[];
  };
  classification?: RuntimeClassificationResult;
  retrieval?: RuntimeRetrievalDecision & {
    query?: string;
    toolFamilies?: string[];
  };
  plan?: {
    kind: 'answer' | 'tool_loop' | 'compatibility_delegate';
    reason?: string;
    steps: string[];
  };
  execution?: {
    delegatedTo?: 'vercel' | 'legacy';
    steps: RuntimeExecutionStepState[];
  };
  evidence?: RuntimeEvidenceItem[];
  parity?: RuntimeParityReport;
  diagnostics: RuntimeDiagnostics;
  failure?: {
    code: string;
    message: string;
    retriable: boolean;
  };
};

export const createInitialRuntimeState = (input: {
  run: RuntimeState['run'];
  conversation: RuntimeState['conversation'];
  actor: RuntimeActor;
  permissions: RuntimePermissions;
  prompt: RuntimeState['prompt'];
  history?: RuntimeState['history'];
  delivery?: Partial<RuntimeState['delivery']>;
}): RuntimeState => ({
  version: 1,
  run: input.run,
  conversation: input.conversation,
  actor: input.actor,
  permissions: input.permissions,
  prompt: input.prompt,
  history: input.history ?? {
    messages: [],
    refs: {},
  },
  delivery: {
    statusMessageId: input.delivery?.statusMessageId,
    finalMessageId: input.delivery?.finalMessageId,
    sentDedupeKeys: input.delivery?.sentDedupeKeys ?? [],
    outbox: input.delivery?.outbox ?? [],
  },
  diagnostics: createEmptyRuntimeDiagnostics(),
});
