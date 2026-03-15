import { randomUUID } from 'crypto';

import { extractJsonObject } from '../langchain/json-output';
import type {
  ControllerActionKind,
  ObjectiveContract,
  ObjectiveOutput,
  ObjectiveOutputKind,
  WorkerCapability,
} from './types';

const GREETING_PATTERN = /^(hi|hello|hey|yo|good morning|good afternoon|good evening)([.!?\s]|$)/i;
const REPO_PATTERN = /\b(github|repo|repository|readme\.md|prompt\.ts|raw file|source code|codebase|open source)\b/i;
const STORE_PATTERN = /\b(store|save|write|put .*workspace|in this workspace)\b/i;
const TERMINAL_PATTERN = /\b(run|execute|terminal|shell|command|pnpm|npm|node|python|bash|zsh|install)\b/i;
const WORKSPACE_PATTERN = /\b(workspace|folder|directory|file|files|read file|write file|edit file|create file)\b/i;
const ZOHO_PATTERN = /\b(zoho|crm|deal|deals|lead|leads|contact|contacts|ticket|tickets)\b/i;
const LARK_PATTERN = /\b(lark|doc|docs|task|tasks|calendar|meeting|meetings|approval|approvals|base)\b/i;
const SEARCH_PATTERN = /\b(search|research|compare|find|latest|current|docs|documentation)\b/i;
const FILE_NAME_PATTERN = /\b([A-Za-z0-9._-]+\.(?:ts|tsx|js|jsx|md|json|py|txt|yaml|yml|toml|cjs|mjs|rs|go|java|kt|swift))\b/i;

const buildOutput = (
  kind: ObjectiveOutputKind,
  description: string,
  verification: ObjectiveOutput['verification'],
  metadata?: Record<string, unknown>,
): ObjectiveOutput => ({
  id: randomUUID(),
  kind,
  description,
  verification,
  ...(metadata ? { metadata } : {}),
});

const sanitizeList = (values: unknown, limit: number): string[] =>
  Array.isArray(values)
    ? values
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, limit)
    : [];

const inferDomainQuery = (message: string, targetFileName?: string): string => {
  const stripped = message
    .replace(/\b(fetch|get|find|search|store|save|write|put|this workspace|workspace|github|repo|repository)\b/gi, ' ')
    .replace(targetFileName ? new RegExp(targetFileName.replace('.', '\\.'), 'ig') : /$^/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : message.trim();
};

export const buildObjectivePrompt = (input: {
  message: string;
  workspaceLabel?: string | null;
  contextBlock: string;
  workers: WorkerCapability[];
}): string => {
  const workerSection = input.workers
    .map((worker) => `- ${worker.workerKey}: ${worker.description} [actions=${worker.actionKinds.join(', ')}]`)
    .join('\n');

  return [
    'You are the only controller for a hierarchical multi-agent runtime.',
    'Return JSON only.',
    'You are not deciding the next worker yet. You are defining the objective contract that the controller loop must satisfy.',
    'Represent the request as requested outputs and constraints, not as prompt-specific task classes.',
    'Allowed output kinds: direct_reply, research_answer, remote_artifact, workspace_mutation, terminal_result, remote_entity.',
    'Allowed verification requirements: non_empty_content, source_citation, workspace_path, workspace_content, terminal_exit, terminal_output, entity_evidence.',
    'Required JSON shape:',
    '{"objectiveSummary":"...","successCriteria":["..."],"requestedOutputs":[{"kind":"...","description":"...","verification":["..."],"metadata":{"optional":"..."}}],"allowLocalMutation":true|false,"requiresApproval":true|false,"blockingQuestions":["..."],"planVisibility":"hidden|compact|detailed","directReply":"optional","domains":["..."],"notes":["..."]}',
    'Rules:',
    '- Greetings and small talk should produce one direct_reply output and may include directReply.',
    '- If the user wants a remote file/code/doc fetched, use remote_artifact.',
    '- If the user wants a local save/edit after retrieval, add workspace_mutation as a separate output.',
    '- If the user wants terminal execution, add terminal_result.',
    '- If the user wants Zoho/Lark/business data, add remote_entity and mention the domain.',
    '- If the user wants current docs/web research, add research_answer.',
    '- Do not mention workers by name inside output descriptions unless necessary.',
    input.workspaceLabel ? `Workspace available: ${input.workspaceLabel}` : 'No workspace is selected.',
    'Available workers:',
    workerSection,
    input.contextBlock,
    `User request: ${input.message}`,
  ].filter(Boolean).join('\n\n');
};

export const inferObjectiveFallback = (message: string, workspaceAvailable: boolean): ObjectiveContract => {
  const trimmed = message.trim();
  const fileMatch = trimmed.match(FILE_NAME_PATTERN);
  const targetFileName = fileMatch?.[1];
  const wantsStore = STORE_PATTERN.test(trimmed);
  const wantsRepo = REPO_PATTERN.test(trimmed) || Boolean(targetFileName);
  const wantsTerminal = TERMINAL_PATTERN.test(trimmed);
  const wantsWorkspace = WORKSPACE_PATTERN.test(trimmed);
  const domains: string[] = [];

  if (GREETING_PATTERN.test(trimmed) && trimmed.length < 60) {
    return {
      objectiveSummary: 'Respond helpfully to the greeting',
      successCriteria: ['Reply briefly and naturally'],
      requestedOutputs: [
        buildOutput('direct_reply', 'A short direct reply to the greeting', [], { audience: 'user' }),
      ],
      allowLocalMutation: false,
      requiresApproval: false,
      blockingQuestions: [],
      planVisibility: 'hidden',
      directReply: 'Hello. How can I help?',
      domains: [],
      notes: [],
    };
  }

  if (wantsRepo) domains.push('repository');
  if (ZOHO_PATTERN.test(trimmed)) domains.push('zoho');
  if (LARK_PATTERN.test(trimmed)) domains.push('lark');
  if (SEARCH_PATTERN.test(trimmed)) domains.push('research');
  if (wantsTerminal) domains.push('terminal');
  if (wantsWorkspace || wantsStore) domains.push('workspace');

  const requestedOutputs: ObjectiveOutput[] = [];
  if (wantsRepo) {
    requestedOutputs.push(
      buildOutput(
        'remote_artifact',
        targetFileName ? `Retrieve the requested remote artifact ${targetFileName}` : 'Retrieve the requested remote artifact',
        ['non_empty_content', 'source_citation'],
        {
          artifactType: 'repository_file',
          targetFileName,
          requireRoot: /root\b/i.test(trimmed),
          domainQuery: inferDomainQuery(trimmed, targetFileName),
        },
      ),
    );
  }
  if (wantsStore || (wantsWorkspace && wantsRepo)) {
    requestedOutputs.push(
      buildOutput(
        'workspace_mutation',
        'Persist the requested output into the local workspace',
        ['workspace_path', 'workspace_content'],
        {
          targetPath: targetFileName ?? undefined,
        },
      ),
    );
  }
  if (wantsTerminal) {
    requestedOutputs.push(
      buildOutput(
        'terminal_result',
        'Execute the necessary terminal command and capture the grounded result',
        ['terminal_exit', 'terminal_output'],
        {
          commandHint: trimmed,
        },
      ),
    );
  }
  if (ZOHO_PATTERN.test(trimmed) || LARK_PATTERN.test(trimmed)) {
    requestedOutputs.push(
      buildOutput(
        'remote_entity',
        'Fetch or update the requested remote business data',
        ['entity_evidence'],
        {
          domains,
        },
      ),
    );
  }
  if (!requestedOutputs.length || (SEARCH_PATTERN.test(trimmed) && !wantsRepo)) {
    requestedOutputs.push(
      buildOutput(
        'research_answer',
        'Gather grounded information and answer from evidence',
        ['source_citation'],
        {
          query: trimmed,
        },
      ),
    );
  }

  return {
    objectiveSummary: trimmed,
    successCriteria: requestedOutputs.map((output) => output.description).slice(0, 4),
    requestedOutputs,
    allowLocalMutation: workspaceAvailable && requestedOutputs.some((output) => output.kind === 'workspace_mutation' || output.kind === 'terminal_result'),
    requiresApproval: requestedOutputs.some((output) => output.kind === 'workspace_mutation' || output.kind === 'terminal_result'),
    blockingQuestions: [],
    planVisibility: requestedOutputs.length > 1 ? 'detailed' : 'compact',
    domains,
    notes: [],
  };
};

const normalizeVerification = (value: unknown): ObjectiveOutput['verification'] =>
  Array.isArray(value)
    ? value.filter(
      (item): item is ObjectiveOutput['verification'][number] =>
        item === 'non_empty_content'
        || item === 'source_citation'
        || item === 'workspace_path'
        || item === 'workspace_content'
        || item === 'terminal_exit'
        || item === 'terminal_output'
        || item === 'entity_evidence',
    )
    : [];

export const parseObjectiveContract = (raw: string | null, fallback: ObjectiveContract): ObjectiveContract => {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed.objectiveSummary !== 'string') {
    return fallback;
  }

  const outputs = Array.isArray(parsed.requestedOutputs)
    ? parsed.requestedOutputs
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Record<string, unknown>;
        const kind = record.kind;
        if (
          kind !== 'direct_reply'
          && kind !== 'research_answer'
          && kind !== 'remote_artifact'
          && kind !== 'workspace_mutation'
          && kind !== 'terminal_result'
          && kind !== 'remote_entity'
        ) {
          return null;
        }
        if (typeof record.description !== 'string' || !record.description.trim()) {
          return null;
        }
        return buildOutput(
          kind,
          record.description.trim(),
          normalizeVerification(record.verification),
          record.metadata && typeof record.metadata === 'object' ? record.metadata as Record<string, unknown> : undefined,
        );
      })
      .filter((item): item is ObjectiveOutput => Boolean(item))
    : [];

  return {
    objectiveSummary: parsed.objectiveSummary.trim(),
    successCriteria: sanitizeList(parsed.successCriteria, 4).length > 0 ? sanitizeList(parsed.successCriteria, 4) : fallback.successCriteria,
    requestedOutputs: outputs.length > 0 ? outputs : fallback.requestedOutputs,
    allowLocalMutation: typeof parsed.allowLocalMutation === 'boolean' ? parsed.allowLocalMutation : fallback.allowLocalMutation,
    requiresApproval: typeof parsed.requiresApproval === 'boolean' ? parsed.requiresApproval : fallback.requiresApproval,
    blockingQuestions: sanitizeList(parsed.blockingQuestions, 4),
    planVisibility:
      parsed.planVisibility === 'hidden' || parsed.planVisibility === 'compact' || parsed.planVisibility === 'detailed'
        ? parsed.planVisibility
        : fallback.planVisibility,
    directReply: typeof parsed.directReply === 'string' ? parsed.directReply.trim() : fallback.directReply,
    domains: sanitizeList(parsed.domains, 6),
    notes: sanitizeList(parsed.notes, 6),
  };
};

export const buildWorkerCatalogContext = (workers: WorkerCapability[]): string =>
  workers
    .map((worker) => {
      const actions = worker.actionKinds.join(', ');
      const domains = worker.domains.length > 0 ? worker.domains.join(', ') : 'general';
      return `- ${worker.workerKey}: ${worker.description} [actions=${actions}] [domains=${domains}]`;
    })
    .join('\n');

export const buildDecisionPrompt = (input: {
  stateSummary: string;
  workers: WorkerCapability[];
}): string => {
  return [
    'You are the only controller for a hierarchical multi-agent runtime.',
    'Return JSON only.',
    'You may decide exactly one next action based on the runtime state.',
    'Allowed decision JSON shapes:',
    '- {"decision":"CALL_WORKER","invocation":{"workerKey":"...","actionKind":"DISCOVER_CANDIDATES|INSPECT_CANDIDATE|RETRIEVE_ARTIFACT|QUERY_REMOTE_SYSTEM|VERIFY_OUTPUT","input":{...}},"reasoning":"optional"}',
    '- {"decision":"REQUEST_LOCAL_ACTION","actionKind":"MUTATE_WORKSPACE|EXECUTE_COMMAND","localAction":{...},"reasoning":"optional"}',
    '- {"decision":"ASK_USER","question":"..."}',
    '- {"decision":"COMPLETE","reply":"..."}',
    '- {"decision":"FAIL","reason":"..."}',
    'Rules:',
    '- Only COMPLETE when all requested outputs are satisfied by verified evidence.',
    '- If the last attempt made no progress, switch strategy instead of repeating the same worker and input.',
    '- Workers are subordinate and may not decide completion.',
    '- Prefer discovery before retrieval when the concrete artifact location is unknown.',
    'Available workers:',
    buildWorkerCatalogContext(input.workers),
    input.stateSummary,
  ].join('\n\n');
};

export const normalizeActionKind = (value: unknown): ControllerActionKind | null => {
  if (
    value === 'DISCOVER_CANDIDATES'
    || value === 'INSPECT_CANDIDATE'
    || value === 'RETRIEVE_ARTIFACT'
    || value === 'QUERY_REMOTE_SYSTEM'
    || value === 'MUTATE_WORKSPACE'
    || value === 'EXECUTE_COMMAND'
    || value === 'VERIFY_OUTPUT'
    || value === 'ASK_USER'
    || value === 'COMPLETE'
    || value === 'FAIL'
  ) {
    return value;
  }
  return null;
};

