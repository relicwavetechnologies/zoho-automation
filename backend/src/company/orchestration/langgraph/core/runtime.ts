import type { ModelMessage } from 'ai';

import { retrievalOrchestratorService } from '../../../retrieval';
import { buildVisionContent, type AttachedFileRef } from '../../../../modules/desktop-chat/file-vision.builder';
import { getSupportedToolActionGroups, type ToolActionGroup } from '../../../tools/tool-action-groups';
import type { GraphToolFamily } from '../graph-tool-facade';
import { isGraphToolFamilyName } from '../graph-tool-facade';
import type { RuntimeState } from '../runtime.state';
import type {
  RuntimeClassificationResult,
  RuntimeEvidenceItem,
  RuntimeGroundedEvidence,
  RuntimeRetrievalDecision,
} from '../runtime.types';
import type { PendingApprovalAction, VercelRuntimeRequestContext } from '../../vercel/types';

export const summarizeGraphText = (value: string | null | undefined, limit = 280): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
};

export const toReadOnlyAllowedActions = (input: {
  allowedToolIds: string[];
  allowedActionsByTool?: Record<string, ToolActionGroup[]>;
}): Record<string, ToolActionGroup[]> =>
  Object.fromEntries(
    input.allowedToolIds
      .map((toolId) => {
        const explicit = input.allowedActionsByTool?.[toolId];
        const supported = explicit && explicit.length > 0 ? explicit : getSupportedToolActionGroups(toolId);
        const allowed = supported.filter((actionGroup) => actionGroup === 'read');
        return allowed.length > 0 ? [toolId, allowed] : null;
      })
      .filter((entry): entry is [string, ToolActionGroup[]] => Boolean(entry)),
  );

export const buildReadOnlyRuntimeContext = (input: {
  state: RuntimeState;
  threadId: string;
  chatId?: string;
  executionId: string;
  sourceUserId?: string;
  mode: VercelRuntimeRequestContext['mode'];
  workspace?: VercelRuntimeRequestContext['workspace'];
  latestActionResult?: VercelRuntimeRequestContext['latestActionResult'];
  readOnly?: boolean;
}): VercelRuntimeRequestContext => {
  const requesterUserId = input.state.actor.linkedUserId ?? input.state.actor.userId ?? input.sourceUserId;
  if (!requesterUserId) {
    throw new Error('Graph runtime requires a requester user id.');
  }

  const allowedToolIds = input.state.permissions.allowedToolIds.filter(
    (toolId) => !input.state.permissions.blockedToolIds.includes(toolId),
  );

  return {
    channel: input.state.run.channel,
    threadId: input.threadId,
    chatId: input.chatId,
    executionId: input.executionId,
    companyId: input.state.conversation.companyId,
    userId: requesterUserId,
    requesterAiRole: input.state.actor.aiRole ?? 'MEMBER',
    requesterEmail: input.state.actor.requesterEmail,
    departmentId: input.state.conversation.departmentId,
    departmentName: input.state.prompt.departmentName,
    departmentRoleSlug: input.state.prompt.departmentRoleSlug,
    larkTenantKey: input.state.actor.larkTenantKey,
    larkOpenId: input.state.actor.larkOpenId,
    larkUserId: input.state.actor.larkUserId,
    authProvider:
      input.state.run.channel === 'lark'
      || Boolean(input.state.actor.larkTenantKey || input.state.actor.larkOpenId || input.state.actor.larkUserId)
        ? 'lark'
        : 'desktop',
    mode: input.mode,
    workspace: input.workspace,
    dateScope: input.state.prompt.dateScope,
    latestActionResult: input.latestActionResult,
    allowedToolIds,
    allowedActionsByTool: input.readOnly === false
      ? input.state.permissions.allowedActionsByTool
      : toReadOnlyAllowedActions({
        allowedToolIds,
        allowedActionsByTool: input.state.permissions.allowedActionsByTool,
      }),
    departmentSystemPrompt: input.state.prompt.departmentPrompt,
    departmentSkillsMarkdown: input.state.prompt.skillsMarkdown,
  };
};

export const buildClassifierPrompt = (messageText: string) => [
  'Classify the request and respond with JSON only.',
  'Keys: intent, complexity, freshnessNeed, risk, domains, retrievalMode, knowledgeNeeds, preferredStrategy.',
  'Allowed complexity: simple, multi_step.',
  'Allowed freshnessNeed: none, maybe, required.',
  'Allowed risk: low, medium, high.',
  'Allowed retrievalMode: none, vector, web, both.',
  'Allowed knowledgeNeeds: crm_entity, company_docs, workflow_skill, conversation_memory, hybrid_web, structured_finance, attachment_exact, relationship.',
  'Allowed preferredStrategy: zoho_vector_plus_live, doc_chunk_search, doc_full_read, skill_db_search, chat_memory, internal_plus_web, structured_parser_plus_doc, attachment_first.',
  'Use domains from: zoho, books, docs, web, outreach, lark, repo, coding, google.',
  `Message: ${messageText}`,
].join('\n');

const summarizeGroundedEvidence = (evidence: RuntimeGroundedEvidence[] | undefined): string =>
  evidence && evidence.length > 0
    ? evidence
      .slice(0, 6)
      .map((entry, index) =>
        `${index + 1}. [${entry.sourceFamily}${entry.staleRisk ? `/${entry.staleRisk}` : ''}] ${entry.title ?? entry.sourceId}: ${entry.excerpt}`,
      )
      .join(' | ')
    : 'none';

export const buildResearchSystemPrompt = (input: {
  state: RuntimeState;
  classification: RuntimeClassificationResult;
  retrieval: RuntimeRetrievalDecision;
  toolFamilies?: GraphToolFamily[];
  additionalInstructions?: string;
}): string => [
  input.state.prompt.baseSystemPrompt,
  input.state.prompt.channelInstructions,
  'You are executing the graph-native LangGraph read path.',
  'Use only read-only tools and do not request or imply mutating actions.',
  input.toolFamilies?.length
    ? `Available tool families for this run: ${input.toolFamilies.join(', ')}.`
    : '',
  input.toolFamilies?.includes('larkTask')
    ? 'Lark task guidance: use larkTask for task reads. Prefer listMine for "my tasks", listOpenMine for "my open tasks", list for broader tasklist reads, and current only for the latest referenced or single current task.'
    : '',
  `Intent: ${input.classification.intent}.`,
  `Freshness: ${input.classification.freshnessNeed}.`,
  `Retrieval mode: ${input.retrieval.mode}.`,
  input.classification.knowledgeNeeds?.length
    ? `Knowledge needs: ${input.classification.knowledgeNeeds.join(', ')}.`
    : '',
  input.classification.preferredStrategy
    ? `Preferred retrieval strategy: ${input.classification.preferredStrategy}.`
    : '',
  input.retrieval.portfolioPlan?.steps.length
    ? `Retrieval portfolio plan: ${input.retrieval.portfolioPlan.steps.map((step) => `${step.need}:${step.strategy}${step.required ? ':required' : ':optional'}`).join(' | ')}.`
    : '',
  ...(input.retrieval.systemDirectives ?? []),
  input.state.prompt.departmentPrompt ? `Department instructions:\n${input.state.prompt.departmentPrompt}` : '',
  input.state.prompt.skillsMarkdown ? `Skills context:\n${input.state.prompt.skillsMarkdown}` : '',
  input.additionalInstructions?.trim() ? input.additionalInstructions.trim() : '',
].filter(Boolean).join('\n\n');

export const buildSynthesisJsonPrompt = (input: {
  classification: RuntimeClassificationResult;
  answerDraft: string;
  evidence: RuntimeEvidenceItem[];
  groundedEvidence?: RuntimeGroundedEvidence[];
}): string => [
  'Respond with JSON only.',
  'Keys: text, taskStatus.',
  'taskStatus must be one of: done, failed, cancelled.',
  'Ground the answer in the evidence and do not invent tool results.',
  'If internal and web evidence are both present, explicitly separate them.',
  'If CRM/live-read context is used for current facts, present it as the system-of-record and treat vector context as supporting evidence.',
  `Intent: ${input.classification.intent}`,
  `Draft answer: ${input.answerDraft}`,
  `Evidence summary: ${input.evidence.slice(0, 5).map((entry, index) => `${index + 1}. ${entry.summary}`).join(' | ') || 'none'}`,
  `Grounded evidence summary: ${summarizeGroundedEvidence(input.groundedEvidence)}`,
].join('\n');

export const buildSynthesisTextPrompt = (input: {
  state: RuntimeState;
  classification: RuntimeClassificationResult;
  answerDraft: string;
  evidence: RuntimeEvidenceItem[];
  groundedEvidence?: RuntimeGroundedEvidence[];
}): string => [
  input.state.prompt.baseSystemPrompt,
  input.state.prompt.channelInstructions,
  'Compose the final answer for the user.',
  'Ground the response only in the evidence and completed tool results.',
  'Do not claim any mutation, approval, or side effect that did not occur.',
  'If internal and web evidence are both present, explicitly separate them in the answer.',
  'If CRM/live-read context is used for freshness-sensitive facts, present it as current system-of-record context and treat vector context as supporting evidence.',
  'Return plain text only.',
  `Intent: ${input.classification.intent}.`,
  `Draft answer: ${input.answerDraft}`,
  `Evidence summary: ${input.evidence.slice(0, 5).map((entry, index) => `${index + 1}. ${entry.summary}`).join(' | ') || 'none'}`,
  `Grounded evidence summary: ${summarizeGroundedEvidence(input.groundedEvidence)}`,
].join('\n\n');

export const selectToolFamilies = (input: {
  classification: RuntimeClassificationResult;
  retrieval: RuntimeRetrievalDecision;
  hasAttachments?: boolean;
}): GraphToolFamily[] => {
  return retrievalOrchestratorService
    .planExecution({
      messageText: input.retrieval.query ?? '',
      intent: input.classification.intent,
      domains: input.classification.domains,
      freshnessNeed: input.classification.freshnessNeed,
      retrievalMode: input.retrieval.mode,
      hasAttachments: input.hasAttachments,
    })
    .toolFamilies
    .filter(isGraphToolFamilyName);
};

export const buildInputMessages = async (input: {
  state: RuntimeState;
  messageText: string;
  runtime: VercelRuntimeRequestContext;
  attachedFiles?: AttachedFileRef[];
  historyMessages?: ModelMessage[];
}): Promise<ModelMessage[]> => {
  const currentText = input.messageText.trim();
  const baseHistory = input.historyMessages
    ?? input.state.history.messages
      .filter((entry) => entry.role === 'system' || entry.role === 'user' || entry.role === 'assistant')
      .map((entry) => ({
        role: entry.role,
        content: entry.content,
      })) as ModelMessage[];

  const currentAttachments = input.attachedFiles ?? [];
  if (currentAttachments.length > 0) {
    const withoutCurrentUser =
      baseHistory.length > 0 && baseHistory[baseHistory.length - 1]?.role === 'user'
        ? baseHistory.slice(0, -1)
        : baseHistory;
    const visionParts = await buildVisionContent({
      userMessage: currentText,
      attachedFiles: currentAttachments,
      companyId: input.runtime.companyId,
      requesterUserId: input.runtime.userId,
      requesterAiRole: input.runtime.requesterAiRole,
    });
    return [
      ...withoutCurrentUser,
      { role: 'user', content: visionParts as ModelMessage['content'] },
    ];
  }

  return baseHistory.length > 0
    ? baseHistory
    : [{ role: 'user', content: currentText }];
};

export const collectEvidenceFromToolOutput = (toolName: string, output: Record<string, unknown>): RuntimeEvidenceItem[] => {
  const evidence: RuntimeEvidenceItem[] = [];
  const citations = Array.isArray(output.citations) ? output.citations : [];
  for (const citation of citations) {
    const record = typeof citation === 'object' && citation !== null ? citation as Record<string, unknown> : null;
    if (!record) continue;
    evidence.push({
      kind: 'citation',
      toolName,
      title: typeof record.title === 'string' ? record.title : undefined,
      summary: typeof record.title === 'string' ? record.title : `${toolName} citation`,
      url: typeof record.url === 'string' ? record.url : undefined,
      sourceType: typeof record.sourceType === 'string' ? record.sourceType : undefined,
      sourceId: typeof record.sourceId === 'string' ? record.sourceId : undefined,
      fileAssetId: typeof record.fileAssetId === 'string' ? record.fileAssetId : undefined,
      chunkIndex: typeof record.chunkIndex === 'number' ? record.chunkIndex : undefined,
      payload: record,
    });
  }
  const fullPayload = output.fullPayload;
  if (fullPayload && typeof fullPayload === 'object' && !Array.isArray(fullPayload)) {
    evidence.push({
      kind: 'tool_result',
      toolName,
      summary: typeof output.summary === 'string' ? output.summary : `${toolName} result`,
      payload: fullPayload as Record<string, unknown>,
    });
  }
  return evidence;
};

export const findPendingApproval = (
  steps: Array<{ toolResults?: Array<{ output?: unknown }> }>,
): PendingApprovalAction | null => {
  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      const output = result.output as { pendingApprovalAction?: PendingApprovalAction } | undefined;
      if (output?.pendingApprovalAction) {
        return output.pendingApprovalAction;
      }
    }
  }
  return null;
};

export const shouldDelegateToCompatibility = (input: {
  planSteps?: string[];
  classification: RuntimeClassificationResult;
  retrieval: RuntimeRetrievalDecision;
}): string | null => {
  if (input.classification.intent === 'write_intent') {
    return 'mutating_request';
  }
  if (input.classification.intent === 'coding') {
    return 'coding_request';
  }
  if ((input.planSteps ?? []).some((step) => step === 'agent.invoke.zoho-action' || step === 'agent.invoke.lark-doc')) {
    return 'compatibility_tool_chain';
  }
  if (input.classification.complexity === 'multi_step' && input.retrieval.mode === 'none') {
    return 'multi_step_without_read_path';
  }
  return null;
};

export const buildDeterministicSynthesis = (input: {
  answerDraft: string;
  evidence: RuntimeEvidenceItem[];
}): { text: string; taskStatus: 'done' | 'failed' | 'cancelled' } => {
  const draft = input.answerDraft.trim();
  if (draft.length > 0) {
    return {
      text: draft,
      taskStatus: 'done',
    };
  }

  const summary = input.evidence.slice(0, 3).map((entry) => entry.summary).filter(Boolean).join(' ');
  return {
    text: summary.length > 0 ? summary : 'Request processed successfully.',
    taskStatus: 'done',
  };
};
