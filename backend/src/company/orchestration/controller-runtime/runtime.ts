import { createHash } from 'crypto';
import type { ZodTypeAny } from 'zod';
import { logger } from '../../../utils/logger';

import { extractJsonObject } from '../langchain/json-output';
import { buildDecisionPrompt, buildParamPrompt, buildSynthesisPrompt, normalizeActionKind } from './prompts';
import { getRequiredSkillTools, parseSkillToolRequirements } from './skill-tool-requirements';
import type {
  ArtifactRecord,
  ControllerDecision,
  ControllerRuntimeHooks,
  ControllerRuntimeResult,
  ControllerRuntimeState,
  LocalActionRecord,
  SkillMetadata,
  TodoListState,
  VerificationResult,
  WorkerCapability,
  WorkerInvocation,
  WorkerObservation,
} from './types';
import { evaluateCheckRegistry } from '../../../modules/desktop-chat/check-registry';
import { DecisionRouter, MAX_HOPS } from '../../../modules/desktop-chat/decision-router';
import { WorkerContracts } from '../../../modules/desktop-chat/worker-contracts';

const MAX_CONTROLLER_STEPS = MAX_HOPS;
const INTERNAL_NO_NEXT_STEP_REASON = 'The controller did not produce a valid next step, and there is not enough grounded evidence to finish safely.';
const summarizeForLog = (value: string): string =>
  value.replace(/\s+/g, ' ').trim().slice(0, 220);

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'before',
  'by',
  'can',
  'do',
  'for',
  'from',
  'get',
  'i',
  'if',
  'in',
  'is',
  'it',
  'let',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'should',
  'start',
  'tell',
  'that',
  'the',
  'then',
  'this',
  'to',
  'today',
  'use',
  'want',
  'we',
  'what',
  'with',
  'workflow',
  'you',
]);

const stableStringify = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
};

const tokenize = (value: string): string[] =>
  value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const hashInput = (value: unknown): string =>
  createHash('sha1').update(stableStringify(value)).digest('hex');

const hashLocalAction = (value: unknown): string => hashInput(value);

const artifactKey = (artifact: ArtifactRecord): string => artifact.id || artifact.url || artifact.title || JSON.stringify(artifact);

const collectKnownFacts = (state: ControllerRuntimeState<unknown>): Set<string> =>
  new Set(state.observations.flatMap((observation) => observation.facts));

const collectKnownArtifacts = (state: ControllerRuntimeState<unknown>): Set<string> =>
  new Set(state.observations.flatMap((observation) => observation.artifacts.map(artifactKey)));

const hasCitation = (state: ControllerRuntimeState<unknown>): boolean =>
  state.observations.some((observation) => observation.citations.length > 0);

const collectArtifacts = (state: ControllerRuntimeState<unknown>, predicate: (artifact: ArtifactRecord) => boolean): ArtifactRecord[] =>
  state.observations.flatMap((observation) => observation.artifacts.filter(predicate));

const findArtifact = (state: ControllerRuntimeState<unknown>, predicate: (artifact: ArtifactRecord) => boolean): ArtifactRecord | null => {
  for (const observation of state.observations) {
    const artifact = observation.artifacts.find(predicate);
    if (artifact) return artifact;
  }
  return null;
};

const hasSkillMetadataArtifact = (state: ControllerRuntimeState<unknown>): boolean =>
  Boolean(findArtifact(state, (artifact) => artifact.type === 'skill_metadata' || artifact.type === 'skill_document'))
  || Boolean(state.resolvedSkillId);

const hasSkillDocumentArtifact = (state: ControllerRuntimeState<unknown>): boolean =>
  typeof state.loadedSkillContent === 'string' && state.loadedSkillContent.trim().length > 500;

const hasMeaningfulWorkEvidence = (state: ControllerRuntimeState<unknown>): boolean =>
  (state.workerResults ?? []).some((result) => result.success && result.hasSubstantiveContent && result.workerKey !== 'skills')
  || state.observations.some((observation) => observation.ok && observation.workerKey !== 'skills');

const buildVerificationDetail = (label: string, evidence: string[]): string =>
  evidence.length > 0 ? `${label}: ${evidence.join(' | ')}` : `${label}: pending`;

export const evaluateVerifications = (state: ControllerRuntimeState<unknown>): VerificationResult[] =>
  evaluateCheckRegistry(state);

const allChecksSatisfied = (state: ControllerRuntimeState<unknown>): boolean =>
  evaluateVerifications(state).every((verification) => verification.status === 'satisfied');

const summarizeChecks = (state: ControllerRuntimeState<unknown>): string =>
  evaluateVerifications(state)
    .map((verification) => `- ${verification.status}: ${verification.detail}`)
    .join('\n');

const classifyNoProgress = (
  state: ControllerRuntimeState<unknown>,
  invocation: WorkerInvocation,
): { repeatedNoProgress: boolean; attemptCount: number } => {
  const inputHash = hashInput(invocation.input);
  const signature = `${invocation.workerKey}:${invocation.actionKind}:${inputHash}`;
  const matches = state.progressLedger.filter((record) => record.actionSignature === signature);
  return {
    repeatedNoProgress: matches.some((record) => !record.madeProgress),
    attemptCount: matches.length,
  };
};

const countNoProgressAttemptsByWorkerAction = (
  state: ControllerRuntimeState<unknown>,
  workerKey: string,
  actionKind: WorkerInvocation['actionKind'],
): number =>
  state.progressLedger.filter((record) =>
    record.workerKey === workerKey
    && record.actionKind === actionKind
    && !record.madeProgress).length;

const latestObservationForWorkerAction = (
  state: ControllerRuntimeState<unknown>,
  workerKey: string,
  actionKind: WorkerInvocation['actionKind'],
): WorkerObservation | null => {
  for (let index = state.observations.length - 1; index >= 0; index -= 1) {
    const observation = state.observations[index];
    if (observation?.workerKey === workerKey && observation.actionKind === actionKind) {
      return observation;
    }
  }
  return null;
};

const buildRepeatedWorkerFailureReason = (
  state: ControllerRuntimeState<unknown>,
  workerKey: string,
  actionKind: WorkerInvocation['actionKind'],
): string => {
  const latestObservation = latestObservationForWorkerAction(state, workerKey, actionKind);
  const detail = latestObservation?.blockingReason ?? latestObservation?.summary;
  return detail
    ? `The ${workerKey} worker failed repeatedly while trying ${actionKind.toLowerCase()}: ${detail}`
    : `The ${workerKey} worker failed repeatedly while trying ${actionKind.toLowerCase()}.`;
};

const findExactSkillMetadataMatch = (
  query: string | undefined,
  skills: SkillMetadata[],
): SkillMetadata | null => {
  if (!query) return null;
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  return skills.find((skill) =>
    skill.id.toLowerCase() === normalized || skill.name.toLowerCase() === normalized) ?? null;
};

const extractSummaryJson = (summary: string): Record<string, unknown> | null => {
  const cleaned = summary
    .replace(/^```[\w]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const stripCodeFences = (value: string): string =>
  value
    .replace(/^```[\w-]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

const humanizeWorkerSummary = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const cleaned = stripCodeFences(value);
  if (!cleaned) return '';
  const parsed = extractSummaryJson(cleaned);
  if (parsed) {
    if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
      return parsed.summary.trim();
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  }
  return cleaned;
};

const getWorkerDisplayName = (workerKey: string): string => {
  switch (workerKey) {
    case 'zoho':
      return 'Zoho';
    case 'outreach':
      return 'Outreach';
    case 'larkTask':
      return 'Lark Tasks';
    case 'larkCalendar':
      return 'Lark Calendar';
    case 'larkMeeting':
      return 'Lark Meetings';
    case 'larkDoc':
      return 'Lark Docs';
    case 'larkApproval':
      return 'Lark Approvals';
    case 'larkBase':
      return 'Lark Base';
    case 'skills':
      return 'Skill guidance';
    default:
      return workerKey;
  }
};

const shouldUseRawCompleteReply = (reply: string): boolean => {
  const trimmed = reply.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower.includes('loaded skill.md')) return false;
  if (trimmed.includes('"success"') || trimmed.includes('"recordId"') || trimmed.includes('"workerKey"')) return false;
  if (trimmed.includes('{') && trimmed.includes('}')) return false;
  return true;
};

const buildFallbackCompleteReply = <LocalAction>(
  state: ControllerRuntimeState<LocalAction>,
): string => {
  const findings = (state.workerResults ?? [])
    .filter((result) => result.workerKey !== 'skills')
    .map((result) => {
      const rawSummary =
        result.rawResponse && typeof result.rawResponse === 'object'
          ? (result.rawResponse as Record<string, unknown>).summary
          : null;
      const summary = humanizeWorkerSummary(rawSummary ?? result.llmSummary ?? '');
      if (!summary) return null;
      return `${getWorkerDisplayName(result.workerKey)} — ${summary}`;
    })
    .filter((line): line is string => Boolean(line));

  if (findings.length === 0) {
    return state.profile.missingInputs.length === 0
      ? 'I have everything I need to continue, but I do not have any grounded findings to summarize yet.'
      : `I still need: ${state.profile.missingInputs.join(', ')}.`;
  }

  const intro = /what do you need before you start/i.test(state.userRequest)
    ? 'I have everything I need to start. Here is what I found so far:'
    : 'Here is what I found:';

  return `${intro}\n\n- ${findings.join('\n- ')}\n\nWant me to keep going or turn this into a cleaner summary?`;
};

const inferObservationSuccess = (observation: WorkerObservation): boolean => {
  if (observation.ok === true) return true;
  if (typeof observation.summary !== 'string') return false;
  const parsed = extractSummaryJson(observation.summary);
  if (parsed?.success === true) return true;
  if (parsed?.error === null && typeof parsed?.summary === 'string') return true;
  const lower = observation.summary.toLowerCase();
  return (
    lower.includes('found')
    || lower.includes('retrieved')
    || lower.includes('loaded')
    || lower.includes('matched')
    || lower.includes('created')
    || lower.includes('updated')
  );
};

const inferObservationSubstantive = (
  observation: WorkerObservation,
  inferredSuccess: boolean,
): boolean => {
  if (!inferredSuccess || typeof observation.summary !== 'string') return false;
  const summary = observation.summary.trim();
  if (summary.length < 20) return false;
  const lower = summary.toLowerCase();
  if (
    lower.startsWith('no ')
    && (lower.includes('found') || lower.includes('matched') || lower.includes('result'))
  ) {
    return false;
  }
  return true;
};

const findResolvedSkillMetadata = (
  state: ControllerRuntimeState<unknown>,
  skills: SkillMetadata[],
): SkillMetadata | null => {
  const skillId = state.resolvedSkillId?.trim().toLowerCase();
  if (!skillId) return null;
  return skills.find((skill) => skill.id.toLowerCase() === skillId || skill.name.toLowerCase() === skillId) ?? null;
};

const extractSkillAllowedTools = (content: string | null | undefined): string[] =>
  parseSkillToolRequirements(content).all;

const collectPreferredWorkerHints = (
  state: ControllerRuntimeState<unknown>,
  skills: SkillMetadata[],
): string[] => {
  const resolvedSkill = findResolvedSkillMetadata(state, skills);
  const metadataHints = resolvedSkill?.toolHints ?? [];
  const allowedTools = extractSkillAllowedTools(state.loadedSkillContent);
  return unique([...metadataHints, ...allowedTools]).map((hint) => hint.trim()).filter(Boolean);
};

const inferQueryForWorker = (
  worker: WorkerCapability,
  state: ControllerRuntimeState<unknown>,
): string => {
  const dateScope = typeof state.inferredInputs?.date_scope === 'string' ? state.inferredInputs.date_scope : '';
  const objective = typeof state.inferredInputs?.objective === 'string' ? state.inferredInputs.objective : '';
  const request = state.userRequest.trim();
  const workerText = `${worker.workerKey} ${worker.description}`.toLowerCase();

  if (dateScope && workerText.includes('task')) {
    return `tasks for ${dateScope}`;
  }
  if (dateScope && (workerText.includes('calendar') || workerText.includes('event'))) {
    return `events for ${dateScope}`;
  }
  if (dateScope && workerText.includes('meeting')) {
    return `meetings for ${dateScope}`;
  }
  if (dateScope && (worker.workerKey === 'zoho' || worker.workerKey === 'outreach')) {
    return objective || `context for ${dateScope}`;
  }
  return objective || request;
};

const chooseCapabilityFallbackInvocation = <LocalAction>(
  state: ControllerRuntimeState<LocalAction>,
  workers: WorkerCapability[],
  skills: SkillMetadata[],
): WorkerInvocation | null => {
  if (state.profile.missingInputs.length > 0 || hasMeaningfulWorkEvidence(state)) {
    return null;
  }

  const requestTokens = new Set(tokenize([
    state.userRequest,
    state.profile.summary,
    state.inferredInputs?.objective ?? '',
    state.inferredInputs?.date_scope ?? '',
  ].filter(Boolean).join(' ')));
  const preferredHints = new Set(collectPreferredWorkerHints(state, skills).map((hint) => hint.toLowerCase()));
  const attemptedSignatures = new Set(
    state.progressLedger.map((record) => `${record.workerKey}:${record.actionKind}`),
  );

  let best: { worker: WorkerCapability; actionKind: WorkerInvocation['actionKind']; score: number } | null = null;

  for (const worker of workers) {
    if (worker.requiresApproval || worker.workerKey === 'skills' || worker.workerKey === 'workspace' || worker.workerKey === 'terminal') {
      continue;
    }

    const actionKind = worker.actionKinds.includes('QUERY_REMOTE_SYSTEM')
      ? 'QUERY_REMOTE_SYSTEM'
      : worker.actionKinds.includes('DISCOVER_CANDIDATES')
        ? 'DISCOVER_CANDIDATES'
        : worker.actionKinds.includes('INSPECT_CANDIDATE')
          ? 'INSPECT_CANDIDATE'
          : worker.actionKinds.includes('RETRIEVE_ARTIFACT')
            ? 'RETRIEVE_ARTIFACT'
            : null;

    if (!actionKind) continue;
    if (attemptedSignatures.has(`${worker.workerKey}:${actionKind}`)) continue;

    const workerTokens = unique(tokenize([
      worker.workerKey,
      worker.description,
      worker.domains.join(' '),
      worker.artifactTypes.join(' '),
    ].join(' ')));

    let score = 0;
    if (actionKind === 'QUERY_REMOTE_SYSTEM') score += 4;
    if (worker.artifactTypes.includes('remote_entity')) score += 5;
    if (worker.artifactTypes.includes('citation')) score += 1;
    if (preferredHints.has(worker.workerKey.toLowerCase())) score += 8;
    if (worker.domains.some((domain) => preferredHints.has(domain.toLowerCase()))) score += 3;

    for (const token of workerTokens) {
      if (requestTokens.has(token)) score += 2;
    }

    if (state.userRequest.toLowerCase().includes(worker.workerKey.toLowerCase())) {
      score += 6;
    }

    if (!best || score > best.score) {
      best = { worker, actionKind, score };
    }
  }

  if (!best || best.score <= 0) return null;

  return {
    workerKey: best.worker.workerKey,
    actionKind: best.actionKind,
    input: { query: inferQueryForWorker(best.worker, state) },
  };
};

const isSubstantiveWorkerObservation = (observation: WorkerObservation): boolean => {
  const inferredSuccess = inferObservationSuccess(observation);
  if (!inferredSuccess) return false;
  const raw = observation.rawOutput && typeof observation.rawOutput === 'object'
    ? observation.rawOutput as Record<string, unknown>
    : null;
  if (observation.workerKey === 'skills' && observation.actionKind === 'RETRIEVE_ARTIFACT') {
    const content = typeof raw?.content === 'string' ? raw.content : '';
    const metadata = raw?.metadata && typeof raw.metadata === 'object' ? raw.metadata as Record<string, unknown> : null;
    const description = typeof metadata?.description === 'string' ? metadata.description : '';
    return content.trim().length > 500 && content.trim() !== description.trim();
  }
  return inferObservationSubstantive(observation, inferredSuccess)
    && (observation.entities.length > 0 || observation.artifacts.length > 0 || observation.citations.length > 0 || observation.facts.length > 0);
};

const getWorkerContractSchema = (
  workerKey: string,
  actionKind: WorkerInvocation['actionKind'],
): ZodTypeAny | null => {
  const workerContracts = WorkerContracts[workerKey as keyof typeof WorkerContracts];
  if (!workerContracts) return null;
  const schema = workerContracts[actionKind as keyof typeof workerContracts];
  return schema ?? null;
};

const getPrimaryActionKindForWorker = (
  worker: WorkerCapability,
): WorkerInvocation['actionKind'] | null => {
  if (worker.actionKinds.includes('QUERY_REMOTE_SYSTEM')) return 'QUERY_REMOTE_SYSTEM';
  if (worker.actionKinds.includes('DISCOVER_CANDIDATES')) return 'DISCOVER_CANDIDATES';
  if (worker.actionKinds.includes('INSPECT_CANDIDATE')) return 'INSPECT_CANDIDATE';
  if (worker.actionKinds.includes('RETRIEVE_ARTIFACT')) return 'RETRIEVE_ARTIFACT';
  return null;
};

const describeWorkerContract = (schema: ZodTypeAny | null): string => {
  if (!schema) return '{}';
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (shape && typeof shape === 'object') {
    const fields = Object.keys(shape).sort().map((key) => `"${key}": "<value>"`);
    return `{ ${fields.join(', ')} }`;
  }
  return '{}';
};

const extractToolPurposeFromSkill = (content: string | null | undefined, toolKey: string): string => {
  if (!content) return '';
  const toolLabel = getWorkerDisplayName(toolKey).replace(/^Lark\s/, 'Lark ');
  const lines = content.split('\n').map((line) => line.trim());
  const match = lines.find((line) =>
    line.startsWith('- ')
    && (line.toLowerCase().includes(toolKey.toLowerCase()) || line.toLowerCase().includes(toolLabel.toLowerCase())),
  );
  return match ? match.replace(/^- /, '') : '';
};

const buildResultSummaryLine = (result: {
  workerKey: string;
  rawResponse: unknown;
  llmSummary?: string;
  error?: string;
}): string => {
  const rawSummary =
    result.rawResponse && typeof result.rawResponse === 'object'
      ? (result.rawResponse as Record<string, unknown>).summary
      : null;
  const summary = humanizeWorkerSummary(rawSummary ?? result.llmSummary ?? result.error ?? '');
  return summary ? `${getWorkerDisplayName(result.workerKey)} — ${summary}` : getWorkerDisplayName(result.workerKey);
};

const buildSynthesisReplyFromState = async <LocalAction>(
  state: ControllerRuntimeState<LocalAction>,
  invokeController: (prompt: string) => Promise<string | null>,
): Promise<string> => {
  const results = (state.workerResults ?? [])
    .filter((result) => result.workerKey !== 'skills' && result.success)
    .map((result) => buildResultSummaryLine(result));
  const failures = (state.workerResults ?? [])
    .filter((result) => result.workerKey !== 'skills' && !result.success)
    .map((result) => buildResultSummaryLine(result));
  const raw = await invokeController(buildSynthesisPrompt({
    workflowName: state.resolvedSkillId ?? undefined,
    objective: state.inferredInputs?.objective ?? state.profile.summary,
    results,
    failures,
  }));
  const text = typeof raw === 'string' ? raw.trim() : '';
  return shouldUseRawCompleteReply(text) ? text : buildFallbackCompleteReply(state);
};

const parseParamDecision = (
  raw: string | null,
  expectedActionKind: WorkerInvocation['actionKind'],
): { actionKind: WorkerInvocation['actionKind']; params: Record<string, unknown> } | null => {
  const parsed = extractJsonObject(raw);
  if (!parsed || !parsed.params || typeof parsed.params !== 'object') return null;
  const actionKind = normalizeActionKind(parsed.actionKind);
  if (!actionKind || actionKind !== expectedActionKind) return null;
  return {
    actionKind,
    params: parsed.params as Record<string, unknown>,
  };
};

const summarizeProgressLedger = (state: ControllerRuntimeState<unknown>): string =>
  state.progressLedger.slice(-4).map((record) => (
    `- step=${record.step} worker=${record.workerKey} action=${record.actionKind ?? 'unknown'} progress=${String(record.madeProgress)} artifacts=${record.artifactsAdded.join(', ') || 'none'} facts=${record.factsAdded.join(', ') || 'none'}`
  )).join('\n');

const normalizeState = <LocalAction>(
  state: ControllerRuntimeState<LocalAction>,
): ControllerRuntimeState<LocalAction> => ({
  ...state,
  bootstrap: state.bootstrap ?? state.profile,
  inferredInputs: state.inferredInputs ?? {},
  readinessConfirmed: Boolean(state.readinessConfirmed),
  todoList: state.todoList ?? null,
  terminalEventEmitted: Boolean(state.terminalEventEmitted),
  workerResults: Array.isArray(state.workerResults) ? state.workerResults : [],
  hopCount: typeof state.hopCount === 'number' ? state.hopCount : 0,
  retryCount: typeof state.retryCount === 'number' ? state.retryCount : 0,
  pendingSkillId: typeof state.pendingSkillId === 'string' ? state.pendingSkillId : null,
  resolvedSkillId: typeof state.resolvedSkillId === 'string' ? state.resolvedSkillId : null,
  loadedSkillContent: typeof state.loadedSkillContent === 'string' ? state.loadedSkillContent : null,
  availableSkills: Array.isArray(state.availableSkills) ? state.availableSkills : [],
  lastAction: state.lastAction ?? null,
  lastContractViolation: typeof state.lastContractViolation === 'string' ? state.lastContractViolation : null,
  lifecyclePhase: state.lifecyclePhase ?? 'running',
  localActionHistory: Array.isArray(state.localActionHistory) ? state.localActionHistory : [],
  pendingLocalAction: state.pendingLocalAction
    ? {
      ...state.pendingLocalAction,
      id: state.pendingLocalAction.id ?? `local-action:${hashLocalAction(state.pendingLocalAction.localAction)}`,
      actionHash: state.pendingLocalAction.actionHash ?? hashLocalAction(state.pendingLocalAction.localAction),
      requestedAtStep: typeof state.pendingLocalAction.requestedAtStep === 'number'
        ? state.pendingLocalAction.requestedAtStep
        : state.stepCount,
    }
    : undefined,
});

const buildStateSummary = (
  state: ControllerRuntimeState<unknown>,
  workers: WorkerCapability[],
  skills: SkillMetadata[],
): string => {
  const recentWorkerResults = (state.workerResults ?? []).slice(-4).map((result) => {
    const raw = result.rawResponse && typeof result.rawResponse === 'object'
      ? result.rawResponse as Record<string, unknown>
      : null;
    const skillContent = typeof raw?.content === 'string'
      ? raw.content.slice(0, 4000)
      : null;
    const summary = humanizeWorkerSummary((raw?.summary as string | undefined) ?? result.llmSummary ?? '');
    return [
      `hop=${result.hopIndex} worker=${result.workerKey} action=${result.actionKind} success=${String(result.success)} substantive=${String(result.hasSubstantiveContent)}`,
      summary ? `summary: ${summary}` : '',
      skillContent ? `artifact.content:\n\`\`\`md\n${skillContent}\n\`\`\`` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  const recentObservations = state.observations.map((observation, index) => {
    const citations = observation.citations.map((citation) => citation.url ?? citation.title).filter(Boolean).join(' | ');
    const artifacts = observation.artifacts.map((artifact) => artifact.title ?? artifact.id).join(' | ');
    const summary = humanizeWorkerSummary(observation.summary);
    const facts = observation.facts
      .map((fact) => humanizeWorkerSummary(fact))
      .filter((fact) => fact.length > 0);
    return [
      `${index + 1}. worker=${observation.workerKey} action=${observation.actionKind} ok=${String(observation.ok)}`,
      `summary: ${summary || observation.summary}`,
      facts.length > 0 ? `facts: ${facts.slice(0, 3).join(' | ')}` : '',
      artifacts ? `artifacts: ${artifacts}` : '',
      citations ? `citations: ${citations}` : '',
      observation.blockingReason ? `blocking: ${observation.blockingReason}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const workerSummary = workers
    .map((worker) => `- ${worker.workerKey}: actions=${worker.actionKinds.join(', ')} domains=${worker.domains.join(', ') || 'general'}`)
    .join('\n');
  const preferredWorkerHints = collectPreferredWorkerHints(state, skills);
  const requiredTools = getRequiredSkillTools(state.loadedSkillContent);
  const attemptedWorkers = new Set(
    (state.workerResults ?? [])
      .filter((result) => result.workerKey !== 'skills')
      .map((result) => result.workerKey),
  );
  const completedRequiredTools = requiredTools.filter((tool) => attemptedWorkers.has(tool));
  const pendingRequiredTools = requiredTools.filter((tool) => !attemptedWorkers.has(tool));
  const requiredToolsProgress = requiredTools.length > 0
    ? [
      'Required tools progress:',
      ...completedRequiredTools.map((tool) => `- [x] ${tool} — attempted`),
      ...pendingRequiredTools.map((tool) => `- [ ] ${tool} — NOT YET CALLED`),
      pendingRequiredTools.length > 0
        ? `You must call the remaining tools before completing: ${pendingRequiredTools.join(', ')}`
        : 'All required tools have been attempted. You may now complete.',
    ].join('\n')
    : '';

  return [
    `Task summary: ${state.profile.summary}`,
    `User request: ${state.userRequest}`,
    `Complexity: ${state.profile.complexity}`,
    `Use skills first: ${String(state.profile.shouldUseSkills)}`,
    state.profile.skillQuery ? `Skill query: ${state.profile.skillQuery}` : '',
    state.resolvedSkillId ? `Resolved skill id: ${state.resolvedSkillId}` : '',
    `Readiness gate: ${state.readinessConfirmed ? 'confirmed' : 'pending'}`,
    state.lastContractViolation ? `Last contract violation: ${state.lastContractViolation}` : '',
    state.profile.deliverables.length > 0 ? `Deliverables: ${state.profile.deliverables.join(' | ')}` : '',
    state.profile.missingInputs.length > 0 ? `Missing inputs: ${state.profile.missingInputs.join(' | ')}` : 'Missing inputs: none',
    Object.keys(state.inferredInputs ?? {}).length > 0
      ? `Inferred inputs (treat these as already provided by the user):\n${Object.entries(state.inferredInputs ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
        .map(([key, value]) => `- ${key}: "${value}"`)
        .join('\n')}`
      : '',
    state.profile.notes.length > 0 ? `Notes: ${state.profile.notes.join(' | ')}` : '',
    preferredWorkerHints.length > 0 ? `Preferred worker hints from skill guidance: ${preferredWorkerHints.join(' | ')}` : '',
    requiredToolsProgress,
    !state.readinessConfirmed && hasSkillDocumentArtifact(state) && !hasMeaningfulWorkEvidence(state)
      ? 'Readiness gate is pending. Before the first real worker call, decide whether you already know the objective, scope, and enough context to make the next worker call useful. If yes, proceed immediately. If not, ask one focused readiness question covering all missing context.'
      : '',
    !hasMeaningfulWorkEvidence(state)
      ? 'No grounded non-skill evidence has been gathered yet. The next step should usually be a concrete non-local worker call that starts gathering evidence.'
      : '',
    `Checks:\n${summarizeChecks(state)}`,
    state.progressLedger.length > 0 ? `Recent progress ledger:\n${summarizeProgressLedger(state)}` : 'Recent progress ledger: none',
    recentWorkerResults ? `Recent worker results:\n${recentWorkerResults}` : 'Recent worker results: none',
    recentObservations ? `Recent observations:\n${recentObservations}` : 'Recent observations: none',
    `Available worker capabilities:\n${workerSummary}`,
  ].filter(Boolean).join('\n\n');
};

const parseDecision = <LocalAction>(raw: string | null): ControllerDecision<LocalAction> | null => {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed.decision !== 'string') return null;

  if (parsed.decision === 'CALL_WORKER') {
    const invocation = parsed.invocation && typeof parsed.invocation === 'object'
      ? parsed.invocation as Record<string, unknown>
      : null;
    const actionKind = normalizeActionKind(invocation?.actionKind);
    if (
      invocation
      && typeof invocation.workerKey === 'string'
      && actionKind
      && actionKind !== 'ASK_USER'
      && actionKind !== 'COMPLETE'
      && actionKind !== 'FAIL'
    ) {
      return {
        decision: 'CALL_WORKER',
        invocation: {
          workerKey: invocation.workerKey.trim(),
          actionKind,
          input: invocation.input && typeof invocation.input === 'object'
            ? invocation.input as Record<string, unknown>
            : {},
        },
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined,
      };
    }
  }

  if (
    parsed.decision === 'REQUEST_LOCAL_ACTION'
    && (parsed.actionKind === 'MUTATE_WORKSPACE' || parsed.actionKind === 'EXECUTE_COMMAND')
    && parsed.localAction
  ) {
    return {
      decision: 'REQUEST_LOCAL_ACTION',
      actionKind: parsed.actionKind,
      localAction: parsed.localAction as LocalAction,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined,
    };
  }

  if (parsed.decision === 'ASK_USER' && typeof parsed.question === 'string' && parsed.question.trim()) {
    return { decision: 'ASK_USER', question: parsed.question.trim() };
  }

  if (parsed.decision === 'COMPLETE' && typeof parsed.reply === 'string' && parsed.reply.trim()) {
    return { decision: 'COMPLETE', reply: parsed.reply.trim() };
  }

  if (parsed.decision === 'FAIL' && typeof parsed.reason === 'string' && parsed.reason.trim()) {
    return { decision: 'FAIL', reason: parsed.reason.trim() };
  }

  return null;
};

const hasNewNonLocalProgressSince = <LocalAction>(
  state: ControllerRuntimeState<LocalAction>,
  step: number,
): boolean =>
  state.progressLedger.some((record) =>
    record.step > step
    && record.madeProgress
    && record.workerKey !== 'workspace'
    && record.workerKey !== 'terminal');

const findLatestLocalActionRecord = <LocalAction>(
  state: ControllerRuntimeState<LocalAction>,
  actionKind: 'MUTATE_WORKSPACE' | 'EXECUTE_COMMAND',
  actionHash: string,
): LocalActionRecord<LocalAction> | null => {
  const matches = state.localActionHistory.filter((record) => record.actionKind === actionKind && record.actionHash === actionHash);
  return matches.length > 0 ? matches[matches.length - 1] ?? null : null;
};

const shouldBlockRepeatedLocalAction = <LocalAction>(
  state: ControllerRuntimeState<LocalAction>,
  actionKind: 'MUTATE_WORKSPACE' | 'EXECUTE_COMMAND',
  localAction: LocalAction,
): boolean => {
  const actionHash = hashLocalAction(localAction);
  if (state.pendingLocalAction?.actionHash === actionHash && state.pendingLocalAction.actionKind === actionKind) {
    return true;
  }
  const previous = findLatestLocalActionRecord(state, actionKind, actionHash);
  if (!previous || previous.status === 'pending') return false;
  return !hasNewNonLocalProgressSince(state, previous.resolvedAtStep ?? previous.requestedAtStep);
};

const buildRepeatedLocalActionQuestion = (
  actionKind: 'MUTATE_WORKSPACE' | 'EXECUTE_COMMAND',
): string =>
  actionKind === 'MUTATE_WORKSPACE'
    ? 'The same local workspace action was already attempted and no new evidence has appeared since then. I need a different strategy or clarification before changing the workspace again.'
    : 'The same terminal action was already attempted and no new evidence has appeared since then. I need a different strategy or clarification before running it again.';

const buildFallbackDecision = <LocalAction>(
  state: ControllerRuntimeState<LocalAction>,
  workers: WorkerCapability[],
  skills: SkillMetadata[],
  buildLocalAction: (state: ControllerRuntimeState<LocalAction>, kind: 'MUTATE_WORKSPACE' | 'EXECUTE_COMMAND') => LocalAction | null,
): ControllerDecision<LocalAction> => {
  if (state.profile.complexity === 'ambient' && state.profile.directReply) {
    return { decision: 'COMPLETE', reply: state.profile.directReply };
  }

  if (state.pendingLocalAction) {
    return {
      decision: 'ASK_USER',
      question: `I am waiting on the local action result before I can continue: ${state.pendingLocalAction.summary}`,
    };
  }

  if (state.profile.shouldUseSkills) {
    const skillMetadata = findArtifact(state, (artifact) => artifact.type === 'skill_metadata' || artifact.type === 'skill_document');
    if (!skillMetadata) {
      const exactMatch = findExactSkillMetadataMatch(state.profile.skillQuery, skills);
      if (exactMatch) {
        return {
          decision: 'CALL_WORKER',
          invocation: {
            workerKey: 'skills',
            actionKind: 'RETRIEVE_ARTIFACT',
            input: { id: exactMatch.id },
          },
        };
      }
      return {
        decision: 'CALL_WORKER',
        invocation: {
          workerKey: 'skills',
          actionKind: 'DISCOVER_CANDIDATES',
          input: { query: state.profile.skillQuery ?? state.userRequest },
        },
      };
    }

    const skillDocument = findArtifact(state, (artifact) => artifact.type === 'skill_document');
    if (!skillDocument) {
      return {
        decision: 'CALL_WORKER',
        invocation: {
          workerKey: 'skills',
          actionKind: 'RETRIEVE_ARTIFACT',
          input: { id: skillMetadata.id },
        },
      };
    }
  }

  if (state.profile.missingInputs.length > 0) {
    return {
      decision: 'ASK_USER',
      question: `I need ${state.profile.missingInputs[0]} before I can continue.`,
    };
  }

  const capabilityFallback = chooseCapabilityFallbackInvocation(state, workers, skills);
  if (capabilityFallback) {
    return {
      decision: 'CALL_WORKER',
      invocation: capabilityFallback,
    };
  }

  const workspaceAction = buildLocalAction(state, 'MUTATE_WORKSPACE');
  if (workspaceAction && !shouldBlockRepeatedLocalAction(state, 'MUTATE_WORKSPACE', workspaceAction)) {
    return {
      decision: 'REQUEST_LOCAL_ACTION',
      actionKind: 'MUTATE_WORKSPACE',
      localAction: workspaceAction,
    };
  }

  const terminalAction = buildLocalAction(state, 'EXECUTE_COMMAND');
  if (terminalAction && !shouldBlockRepeatedLocalAction(state, 'EXECUTE_COMMAND', terminalAction)) {
    return {
      decision: 'REQUEST_LOCAL_ACTION',
      actionKind: 'EXECUTE_COMMAND',
      localAction: terminalAction,
    };
  }

  if (allChecksSatisfied(state) || hasMeaningfulWorkEvidence(state)) {
    return {
      decision: 'COMPLETE',
      reply: state.observations.map((observation) => observation.summary).join('\n\n') || state.profile.directReply || 'Completed the request.',
    };
  }

  return {
    decision: 'FAIL',
    reason: INTERNAL_NO_NEXT_STEP_REASON,
  };
};

const applyProgress = (
  state: ControllerRuntimeState<unknown>,
  invocation: WorkerInvocation,
  observation: WorkerObservation,
): ControllerRuntimeState<unknown> => {
  const inferredSuccess = inferObservationSuccess(observation);
  const reconciledObservation: WorkerObservation = {
    ...observation,
    ok: inferredSuccess,
  };
  const knownFacts = collectKnownFacts(state);
  const knownArtifacts = collectKnownArtifacts(state);
  const factsAdded = reconciledObservation.facts.filter((fact) => !knownFacts.has(fact));
  const artifactsAdded = reconciledObservation.artifacts
    .map((artifact) => artifactKey(artifact))
    .filter((key) => !knownArtifacts.has(key));
  const nextState: ControllerRuntimeState<unknown> = {
    ...state,
    observations: [...state.observations, reconciledObservation],
    stepCount: state.stepCount + 1,
  };
  const nextVerifications = evaluateVerifications(nextState);
  const verificationStateChanges = nextVerifications
    .filter((verification) => {
      const previous = state.verifications.find((item) => item.checkId === verification.checkId);
      return previous?.status !== verification.status;
    })
    .map((verification) => `${verification.checkId}:${verification.status}`);
  const hasSubstantiveContent = inferObservationSubstantive(reconciledObservation, inferredSuccess);
  const madeProgress = inferredSuccess && hasSubstantiveContent && (factsAdded.length > 0 || artifactsAdded.length > 0 || verificationStateChanges.length > 0);
  const inputHash = hashInput(invocation.input);
  const raw = reconciledObservation.rawOutput && typeof reconciledObservation.rawOutput === 'object'
    ? reconciledObservation.rawOutput as Record<string, unknown>
    : null;
  const content = typeof raw?.content === 'string' ? raw.content : null;
  const nextResolvedSkillId = reconciledObservation.workerKey === 'skills'
    ? reconciledObservation.artifacts.find((artifact) => artifact.type === 'skill_metadata' || artifact.type === 'skill_document')?.id ?? state.resolvedSkillId ?? null
    : state.resolvedSkillId ?? null;
  const nextLoadedSkillContent = reconciledObservation.workerKey === 'skills' && reconciledObservation.actionKind === 'RETRIEVE_ARTIFACT' && hasSubstantiveContent
    ? content
    : state.loadedSkillContent ?? null;
  const nextRetryCount =
    state.lastAction
    && state.lastAction.workerKey === invocation.workerKey
    && state.lastAction.actionKind === invocation.actionKind
      ? (state.retryCount ?? 0) + 1
      : 0;
  const nextTodoList: TodoListState = (() => {
    let todo = state.todoList ?? null;

    if ((!todo || !todo.initialized) && nextLoadedSkillContent) {
      const requiredTools = getRequiredSkillTools(nextLoadedSkillContent);
      todo = {
        required: requiredTools,
        completed: [],
        failed: [],
        retryCounts: {},
        initialized: true,
      };
    }

    if (!todo || reconciledObservation.workerKey === 'skills') {
      return todo;
    }

    const workerKey = reconciledObservation.workerKey;

    if (reconciledObservation.ok) {
      return {
        ...todo,
        required: todo.required.filter((tool) => tool !== workerKey),
        completed: todo.completed.includes(workerKey) ? todo.completed : [...todo.completed, workerKey],
        failed: todo.failed.filter((tool) => tool !== workerKey),
      };
    }

    if (!todo.required.includes(workerKey)) {
      return todo;
    }

    const retries = (todo.retryCounts[workerKey] ?? 0) + 1;
    return {
      ...todo,
      required: retries >= 2 ? todo.required.filter((tool) => tool !== workerKey) : todo.required,
      failed: retries >= 2 && !todo.failed.includes(workerKey) ? [...todo.failed, workerKey] : todo.failed,
      retryCounts: {
        ...todo.retryCounts,
        [workerKey]: retries,
      },
    };
  })();
  return {
    ...nextState,
    retryCount: nextRetryCount,
    todoList: nextTodoList,
    pendingSkillId: reconciledObservation.workerKey === 'skills' && reconciledObservation.actionKind === 'RETRIEVE_ARTIFACT'
      ? nextResolvedSkillId
      : state.pendingSkillId ?? null,
    resolvedSkillId: nextResolvedSkillId,
    loadedSkillContent: nextLoadedSkillContent,
    lastAction: {
      workerKey: invocation.workerKey,
      actionKind: invocation.actionKind,
      success: inferredSuccess && hasSubstantiveContent,
    },
    lastContractViolation: null,
    workerResults: [
      ...(state.workerResults ?? []),
      {
        hopIndex: state.hopCount,
        workerKey: invocation.workerKey,
        actionKind: invocation.actionKind,
        input: invocation.input,
        rawResponse: reconciledObservation.rawOutput,
        success: inferredSuccess,
        hasSubstantiveContent,
        llmSummary: reconciledObservation.summary,
        ...(inferredSuccess ? {} : { error: reconciledObservation.blockingReason ?? reconciledObservation.summary }),
      },
    ],
    verifications: nextVerifications,
    progressLedger: [
      ...state.progressLedger,
      {
        step: state.stepCount + 1,
        actionSignature: `${invocation.workerKey}:${invocation.actionKind}:${inputHash}`,
        workerKey: invocation.workerKey,
        actionKind: invocation.actionKind,
        inputHash,
        artifactsAdded,
        factsAdded,
        verificationStateChanges,
        blockerClassification: reconciledObservation.blockingReason ? 'blocking_reason' : undefined,
        madeProgress,
      },
    ],
  };
};

export const applyLocalObservation = <LocalAction>(
  state: ControllerRuntimeState<LocalAction>,
  observation: WorkerObservation,
): ControllerRuntimeState<LocalAction> => {
  const normalizedState = normalizeState(state);
  const pendingLocalAction = normalizedState.pendingLocalAction;
  const normalizedObservation = (() => {
    if (!pendingLocalAction) return observation;
    const rawOutput =
      observation.rawOutput && typeof observation.rawOutput === 'object'
        ? observation.rawOutput as Record<string, unknown>
        : {};
    return {
      ...observation,
      rawOutput: {
        ...rawOutput,
        localActionRequestId: pendingLocalAction.id,
        localActionHash: pendingLocalAction.actionHash,
      },
    };
  })();

  const invocation: WorkerInvocation = {
    workerKey: normalizedObservation.workerKey,
    actionKind: normalizedObservation.actionKind,
    input: normalizedObservation.rawOutput && typeof normalizedObservation.rawOutput === 'object'
      ? normalizedObservation.rawOutput as Record<string, unknown>
      : { summary: normalizedObservation.summary },
  };
  const baseState: ControllerRuntimeState<LocalAction> = {
    ...normalizedState,
    lifecyclePhase: 'resuming',
    pendingLocalAction: undefined,
    localActionHistory: pendingLocalAction
      ? normalizedState.localActionHistory.map((record) =>
        record.id === pendingLocalAction.id
          ? {
            ...record,
            status: normalizedObservation.ok ? 'succeeded' : 'failed',
            resolvedAtStep: normalizedState.stepCount,
            observationSummary: normalizedObservation.summary,
          }
          : record)
      : normalizedState.localActionHistory,
  };
  const nextState = applyProgress(baseState, invocation, normalizedObservation) as ControllerRuntimeState<LocalAction>;
  return {
    ...nextState,
    lifecyclePhase: 'running',
  };
};

export const runControllerRuntime = async <LocalAction, PlanView>(input: {
  initialState: ControllerRuntimeState<LocalAction>;
  workers: WorkerCapability[];
  skills: SkillMetadata[];
  invokeController: (prompt: string) => Promise<string | null>;
  executeWorker: (invocation: WorkerInvocation) => Promise<WorkerObservation>;
  buildLocalAction: (state: ControllerRuntimeState<LocalAction>, kind: 'MUTATE_WORKSPACE' | 'EXECUTE_COMMAND') => LocalAction | null;
  hooks?: ControllerRuntimeHooks<LocalAction, PlanView>;
  maxSteps?: number;
}): Promise<ControllerRuntimeResult<LocalAction>> => {
  const router = new DecisionRouter<LocalAction>();
  let state = normalizeState({
    ...input.initialState,
    verifications: evaluateVerifications(input.initialState),
  });
  const hooks = input.hooks;
  const maxSteps = input.maxSteps ?? MAX_CONTROLLER_STEPS;

  if (hooks?.onBootstrap) {
    await hooks.onBootstrap(state, hooks.projectPlan ? hooks.projectPlan(state) : null);
  }
  if (hooks?.onCheckpoint) {
    await hooks.onCheckpoint('controller.bootstrap.ready', state);
  }

  if (state.profile.complexity === 'ambient' && state.profile.directReply) {
    return { kind: 'answer', text: state.profile.directReply, terminalState: 'COMPLETE', state: { ...state, terminalEventEmitted: true } };
  }

  for (let index = 0; index < maxSteps; index += 1) {
    state = {
      ...state,
      hopCount: (state.hopCount ?? 0) + 1,
      verifications: evaluateVerifications(state),
    };

    if (hooks?.onVerification) {
      await hooks.onVerification(state, hooks.projectPlan ? hooks.projectPlan(state) : null);
    }

    const todoReady = state.todoList?.initialized ?? false;
    const todoEmpty = todoReady && (state.todoList?.required.length ?? 0) === 0;
    const budgetExhausted = state.hopCount >= MAX_HOPS - 2;

    if (todoEmpty || budgetExhausted) {
      const reply = await buildSynthesisReplyFromState(state, input.invokeController);
      return {
        kind: 'answer',
        text: reply,
        terminalState: 'COMPLETE',
        state: { ...state, terminalEventEmitted: true },
      };
    }

    let decision: ControllerDecision<LocalAction>;

    if (state.todoList?.initialized && state.todoList.required.length > 0) {
      const nextTool = state.todoList.required[0];
      const worker = input.workers.find((item) => item.workerKey === nextTool);
      const actionKind = worker ? getPrimaryActionKindForWorker(worker) : null;
      if (!worker || !actionKind) {
        state = {
          ...state,
          todoList: {
            ...(state.todoList ?? { required: [], completed: [], failed: [], retryCounts: {}, initialized: true }),
            required: state.todoList.required.filter((tool) => tool !== nextTool),
            failed: state.todoList.failed.includes(nextTool) ? state.todoList.failed : [...state.todoList.failed, nextTool],
          },
        };
        continue;
      }

      const schema = getWorkerContractSchema(nextTool, actionKind);
      const rawParams = await input.invokeController(buildParamPrompt({
        workerKey: nextTool,
        actionKind,
        contract: describeWorkerContract(schema),
        objective: state.inferredInputs?.objective ?? state.profile.summary,
        dateScope: state.inferredInputs?.date_scope,
        skillGuidance: extractToolPurposeFromSkill(state.loadedSkillContent, nextTool),
        previousResults: (state.workerResults ?? []).slice(-2).map((result) => buildResultSummaryLine(result)),
        completedTools: state.todoList.completed,
        toolPurpose: extractToolPurposeFromSkill(state.loadedSkillContent, nextTool),
      }));
      const parsedParams = parseParamDecision(rawParams, actionKind);
      const deterministicFallbackParams = { query: inferQueryForWorker(worker, state) };
      const contractResult = (() => {
        if (schema && parsedParams) {
          const parsed = schema.safeParse(parsedParams.params);
          if (parsed.success) return parsed;
        }
        if (schema) {
          const fallback = schema.safeParse(deterministicFallbackParams);
          if (fallback.success) return fallback;
        }
        return { success: false as const, error: { message: `Could not generate valid parameters for ${nextTool}.` } };
      })();

      if (!schema || !contractResult.success) {
        const retries = (state.todoList.retryCounts[nextTool] ?? 0) + 1;
        const nextTodoList = {
          ...state.todoList,
          required: retries >= 2 ? state.todoList.required.filter((tool) => tool !== nextTool) : state.todoList.required,
          failed: retries >= 2 && !state.todoList.failed.includes(nextTool) ? [...state.todoList.failed, nextTool] : state.todoList.failed,
          retryCounts: {
            ...state.todoList.retryCounts,
            [nextTool]: retries,
          },
        };
        state = {
          ...state,
          todoList: nextTodoList,
          lastContractViolation: schema && parsedParams && !contractResult.success
            ? contractResult.error.message
            : `Could not generate valid parameters for ${nextTool}.`,
        };
        if (retries === 1) {
          return {
            kind: 'answer',
            text: `I need more information to call ${nextTool}. ${state.lastContractViolation ?? 'Please clarify the missing input.'}`,
            terminalState: 'ASK_USER',
            state: { ...state, terminalEventEmitted: true },
          };
        }
        continue;
      }

      decision = {
        decision: 'CALL_WORKER',
        invocation: {
          workerKey: nextTool,
          actionKind,
          input: contractResult.data,
        },
      };
    } else {
      const deterministicDecision = router.route(state);
      const rawDecision = deterministicDecision
        ? null
        : await input.invokeController(buildDecisionPrompt({
          stateSummary: buildStateSummary(state, input.workers, input.skills),
          workers: input.workers,
          skills: input.skills,
        }));

      decision = deterministicDecision ?? parseDecision<LocalAction>(rawDecision) ?? buildFallbackDecision(state, input.workers, input.skills, input.buildLocalAction);
    }

    if (decision.decision === 'CALL_WORKER') {
      if (decision.invocation.workerKey === 'skills' && decision.invocation.actionKind === 'RETRIEVE_ARTIFACT') {
        state = {
          ...state,
          pendingSkillId: typeof decision.invocation.input.id === 'string' ? decision.invocation.input.id : state.pendingSkillId ?? null,
        };
      }
      const noProgressAttempts = countNoProgressAttemptsByWorkerAction(
        state,
        decision.invocation.workerKey,
        decision.invocation.actionKind,
      );
      if (noProgressAttempts >= 2) {
        decision = {
          decision: 'FAIL',
          reason: buildRepeatedWorkerFailureReason(state, decision.invocation.workerKey, decision.invocation.actionKind),
        };
      }
      if (decision.decision === 'CALL_WORKER') {
        const progressInfo = classifyNoProgress(state, decision.invocation);
        if (progressInfo.repeatedNoProgress || progressInfo.attemptCount > 1) {
          decision = buildFallbackDecision(state, input.workers, input.skills, input.buildLocalAction);
        }
      }
    }
    if (
      decision.decision === 'REQUEST_LOCAL_ACTION'
      && shouldBlockRepeatedLocalAction(state, decision.actionKind, decision.localAction)
    ) {
      decision = buildFallbackDecision(state, input.workers, input.skills, input.buildLocalAction);
      if (
        decision.decision === 'REQUEST_LOCAL_ACTION'
        && shouldBlockRepeatedLocalAction(state, decision.actionKind, decision.localAction)
      ) {
        decision = {
          decision: 'ASK_USER',
          question: buildRepeatedLocalActionQuestion(decision.actionKind),
        };
      }
    }

    if (
      (decision.decision === 'ASK_USER' || decision.decision === 'FAIL')
      && state.profile.missingInputs.length === 0
      && !hasMeaningfulWorkEvidence(state)
    ) {
      const capabilityFallback = chooseCapabilityFallbackInvocation(state, input.workers, input.skills);
      if (capabilityFallback) {
        decision = {
          decision: 'CALL_WORKER',
          invocation: capabilityFallback,
        };
      }
    }

    const plan = hooks?.projectPlan ? hooks.projectPlan(state) : null;
    if (hooks?.onDecision) {
      await hooks.onDecision(state, decision, plan);
    }
    if (hooks?.onCheckpoint) {
      await hooks.onCheckpoint(`controller.step.${state.stepCount + 1}`, state, { decision });
    }

    if (decision.decision === 'ASK_USER') {
      return { kind: 'answer', text: decision.question, terminalState: 'ASK_USER', state: { ...state, terminalEventEmitted: true } };
    }
    if (decision.decision === 'FAIL') {
      return { kind: 'answer', text: decision.reason, terminalState: 'FAIL', state: { ...state, terminalEventEmitted: true } };
    }
    if (decision.decision === 'REQUEST_LOCAL_ACTION') {
      const actionHash = hashLocalAction(decision.localAction);
      const actionRequestId = `local-action:${state.stepCount + 1}:${actionHash}`;
      const nextState = {
        ...state,
        lifecyclePhase: 'awaiting_local_action' as const,
        localActionHistory: [
          ...state.localActionHistory,
          {
            id: actionRequestId,
            actionKind: decision.actionKind,
            localAction: decision.localAction,
            actionHash,
            status: 'pending' as const,
            requestedAtStep: state.stepCount,
          },
        ],
        pendingLocalAction: {
          id: actionRequestId,
          actionKind: decision.actionKind,
          localAction: decision.localAction,
          actionHash,
          summary: decision.reasoning ?? `Requested ${decision.actionKind.toLowerCase()}`,
          requestedAtStep: state.stepCount,
        },
      };
      if (hooks?.onLocalActionRequest) {
        await hooks.onLocalActionRequest(nextState, decision, hooks.projectPlan ? hooks.projectPlan(nextState) : null);
      }
      if (hooks?.onCheckpoint) {
        await hooks.onCheckpoint('controller.local_action.requested', nextState, { decision });
      }
      return {
        kind: 'action',
        action: decision.localAction,
        state: nextState,
      };
    }
    if (decision.decision === 'COMPLETE') {
      const canComplete =
        !state.pendingLocalAction
        && (state.profile.complexity === 'ambient'
          || (state.profile.shouldUseSkills ? hasSkillDocumentArtifact(state) : true)
          && state.profile.missingInputs.length === 0
          && (hasMeaningfulWorkEvidence(state) || allChecksSatisfied(state)));
      if (canComplete) {
        const earlyCompletePayload = {
          executionId: state.executionId,
          verifications: state.verifications,
          progressLedger: state.progressLedger,
          workerResults: (state.workerResults ?? []).map((result) => ({
            workerKey: result.workerKey,
            actionKind: result.actionKind,
            success: result.success,
            hasSubstantiveContent: result.hasSubstantiveContent,
          })),
          hopCount: state.hopCount,
          skillContentPreview: state.loadedSkillContent?.slice(0, 200),
        };
        logger.info('debug.early_complete', earlyCompletePayload, { always: true });
        if (hooks?.onCheckpoint) {
          await hooks.onCheckpoint('controller.debug.early_complete', state, {
            debugEarlyComplete: earlyCompletePayload,
          });
        }
        return { kind: 'answer', text: decision.reply, terminalState: 'COMPLETE', state: { ...state, terminalEventEmitted: true } };
      }
      decision = buildFallbackDecision(state, input.workers, input.skills, input.buildLocalAction);
      if (decision.decision !== 'CALL_WORKER' && decision.decision !== 'REQUEST_LOCAL_ACTION') {
        return {
          kind: 'answer',
          text:
            decision.decision === 'ASK_USER'
              ? decision.question
              : decision.decision === 'FAIL'
                ? decision.reason
                : decision.reply,
          terminalState:
            decision.decision === 'ASK_USER'
              ? 'ASK_USER'
              : decision.decision === 'FAIL'
                ? 'FAIL'
                : 'COMPLETE',
          state: { ...state, terminalEventEmitted: true },
        };
      }
    }

    if (decision.decision === 'CALL_WORKER') {
      const schema = getWorkerContractSchema(decision.invocation.workerKey, decision.invocation.actionKind);
      if (!schema) {
        logger.error('runtime.contract.missing', {
          executionId: state.executionId,
          workerKey: decision.invocation.workerKey,
          actionKind: decision.invocation.actionKind,
        }, { always: true });
        return {
          kind: 'answer',
          text: `No contract defined for ${decision.invocation.workerKey}/${decision.invocation.actionKind}.`,
          terminalState: 'FAIL',
          state: { ...state, terminalEventEmitted: true },
        };
      }
      const parsed = schema.safeParse(decision.invocation.input);
      if (!parsed.success) {
        const violation = `${decision.invocation.workerKey}/${decision.invocation.actionKind} input invalid: ${parsed.error.message}`;
        logger.error('runtime.contract.invalid', {
          executionId: state.executionId,
          workerKey: decision.invocation.workerKey,
          actionKind: decision.invocation.actionKind,
          error: parsed.error.message,
        }, { always: true });
        state = {
          ...state,
          retryCount: (state.retryCount ?? 0) + 1,
          lastAction: {
            workerKey: decision.invocation.workerKey,
            actionKind: decision.invocation.actionKind,
            success: false,
          },
          lastContractViolation: violation,
        };
        if ((state.retryCount ?? 0) >= 1) {
          return {
            kind: 'answer',
            text: violation,
            terminalState: 'FAIL',
            state: { ...state, terminalEventEmitted: true },
          };
        }
        continue;
      }
      const validatedInvocation: WorkerInvocation = {
        ...decision.invocation,
        input: parsed.data,
      };
      if (!state.readinessConfirmed && validatedInvocation.workerKey !== 'skills') {
        state = {
          ...state,
          readinessConfirmed: true,
        };
      }
      logger.info('desktop.flow.worker.dispatch', {
        executionId: state.executionId,
        workerKey: validatedInvocation.workerKey,
        actionKind: validatedInvocation.actionKind,
        step: state.stepCount + 1,
      }, { always: true });
      if (hooks?.onWorkerStart) {
        await hooks.onWorkerStart(state, validatedInvocation, plan);
      }
      let observation: WorkerObservation;
      try {
        observation = await input.executeWorker(validatedInvocation);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('runtime.worker.dispatch.error', {
          executionId: state.executionId,
          workerKey: validatedInvocation.workerKey,
          actionKind: validatedInvocation.actionKind,
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        }, { always: true });
        logger.error('desktop.flow.worker.dispatch.error', {
          executionId: state.executionId,
          workerKey: validatedInvocation.workerKey,
          actionKind: validatedInvocation.actionKind,
          error: errorMessage,
        }, { always: true });
        observation = {
          ok: false,
          workerKey: validatedInvocation.workerKey,
          actionKind: validatedInvocation.actionKind,
          summary: `${validatedInvocation.workerKey} failed: ${errorMessage}`,
          entities: [],
          facts: [],
          artifacts: [],
          citations: [],
          rawOutput: null,
          blockingReason: errorMessage,
          retryHint: 'Inspect the worker failure before retrying the same step.',
          verificationHints: [],
        };
      }
      state = applyProgress(state, validatedInvocation, observation) as ControllerRuntimeState<LocalAction>;
      logger.info('desktop.flow.worker.result', {
        executionId: state.executionId,
        workerKey: validatedInvocation.workerKey,
        actionKind: validatedInvocation.actionKind,
        ok: observation.ok,
        summary: summarizeForLog(observation.summary),
      }, { always: true });
      if (hooks?.onWorkerResult) {
        await hooks.onWorkerResult(state, validatedInvocation, observation, hooks.projectPlan ? hooks.projectPlan(state) : null);
      }
      if (hooks?.onCheckpoint) {
        await hooks.onCheckpoint('controller.worker.result', state, {
          invocation: validatedInvocation,
          observation: {
            ok: observation.ok,
            workerKey: observation.workerKey,
            actionKind: observation.actionKind,
            summary: observation.summary,
          },
        });
      }
    }
  }

  return {
    kind: 'answer',
    text: state.observations.map((observation) => observation.summary).join('\n\n') || 'I reached the step limit before I could finish safely.',
    terminalState: 'FAIL',
    state: { ...state, terminalEventEmitted: true },
  };
};
