import { extractJsonObject } from '../langchain/json-output';
import type { ControllerActionKind, ControllerTaskProfile, SkillMetadata, WorkerCapability } from './types';

const GREETING_PATTERN = /^(hi|hello|hey|yo|good morning|good afternoon|good evening)([.!?\s]|$)/i;

const sanitizeList = (values: unknown, limit: number): string[] =>
  Array.isArray(values)
    ? values
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, limit)
    : [];

export const buildWorkerCatalogContext = (workers: WorkerCapability[]): string =>
  workers
    .map((worker) => {
      const actions = worker.actionKinds.join(', ');
      const domains = worker.domains.length > 0 ? worker.domains.join(', ') : 'general';
      return `- ${worker.workerKey}: ${worker.description} [actions=${actions}] [domains=${domains}]`;
    })
    .join('\n');

export const buildSkillCatalogContext = (skills: SkillMetadata[]): string =>
  skills.length === 0
    ? '- none'
    : skills
      .map((skill) =>
        `- ${skill.id}: ${skill.description} [when=${skill.whenToUse.join(' | ')}] [tags=${skill.tags.join(', ')}] [tools=${skill.toolHints.join(', ')}]`)
      .join('\n');

export const buildBootstrapPrompt = (input: {
  message: string;
  contextBlock: string;
  workers: WorkerCapability[];
  skills: SkillMetadata[];
}): string => [
  'You are the single controller for a tool-using assistant.',
  'Return JSON only.',
  'Your job is to understand the request and decide whether it is ambient, simple, or structured.',
  'Simple requests should be solved directly when possible.',
  'Structured or protocol-heavy requests should cause the controller to inspect skill metadata first.',
  'Do not assume every request needs a skill.',
  'Required JSON shape:',
  '{"summary":"...","complexity":"ambient|simple|structured","shouldUseSkills":true|false,"skillQuery":"optional","deliverables":["..."],"missingInputs":["..."],"directReply":"optional","notes":["..."]}',
  'Rules:',
  '- Use complexity="ambient" for greetings and casual chat with no real task.',
  '- Use complexity="simple" for one-step requests or direct factual questions.',
  '- Use complexity="structured" for protocol-heavy, multi-step, cross-system, or format-sensitive work.',
  '- If a skill may help, set shouldUseSkills=true and provide a good skillQuery.',
  '- If the request already maps directly to an available worker (for example tasks, meetings, calendar, Zoho, Outreach, docs, or search), prefer shouldUseSkills=false unless the user explicitly invoked a skill or asked for a workflow/protocol.',
  '- List only truly missing inputs that block progress now.',
  '- Keep deliverables concrete and short.',
  'Available workers:',
  buildWorkerCatalogContext(input.workers),
  'Available skill metadata:',
  buildSkillCatalogContext(input.skills),
  input.contextBlock,
  `User request: ${input.message}`,
].filter(Boolean).join('\n\n');

export const inferBootstrapFallback = (message: string): ControllerTaskProfile => {
  const trimmed = message.trim();
  const codingIntentCount = [
    'code', 'coding', 'bug', 'fix', 'debug', 'refactor', 'script', 'scripts', 'test', 'tests',
    'build', 'lint', 'terminal', 'command', 'shell', 'workspace', 'file', 'files', 'patch',
    'curl', 'pnpm', 'npm', 'node', 'python', 'python3', 'git',
  ].filter((token) => new RegExp(`\\b${token}\\b`, 'i').test(trimmed)).length;
  const larkSurfaceCount = ['task', 'tasks', 'calendar', 'meeting', 'meetings', 'approval', 'approvals', 'doc', 'docs', 'base']
    .filter((token) => new RegExp(`\\b${token}\\b`, 'i').test(trimmed))
    .length;
  const shouldUseCodingSkill = /\b(coding-ops)\b/i.test(trimmed)
    || (codingIntentCount >= 2 && /\b(fix|debug|refactor|script|test|build|lint|run|execute|edit|write|patch|terminal|workspace|curl)\b/i.test(trimmed));
  const shouldUseLarkSkill = /\b(lark-ops)\b/i.test(trimmed)
    || (/\b(lark|feishu)\b/i.test(trimmed) && /\b(workflow|process|protocol|playbook|skill|ops)\b/i.test(trimmed))
    || (/\b(lark|feishu)\b/i.test(trimmed) && larkSurfaceCount >= 2);
  if (GREETING_PATTERN.test(trimmed) && trimmed.length < 80) {
    return {
      summary: 'Respond naturally to the greeting',
      complexity: 'ambient',
      shouldUseSkills: false,
      deliverables: ['brief natural reply'],
      missingInputs: [],
      directReply: 'Hey.',
      notes: [],
    };
  }

  return {
    summary: trimmed,
    complexity: /\b(workflow|process|daily-stuff|protocol|follow-up|schedule|doc|task|plan|compare|research)\b/i.test(trimmed)
      ? 'structured'
      : 'simple',
    shouldUseSkills: /\b(daily-stuff|workflow|process|protocol|playbook|skill)\b/i.test(trimmed) || shouldUseLarkSkill || shouldUseCodingSkill,
    skillQuery: /\b(daily-stuff)\b/i.test(trimmed)
      ? 'daily-stuff'
      : shouldUseCodingSkill
        ? 'coding-ops'
      : shouldUseLarkSkill
        ? 'lark-ops'
        : trimmed,
    deliverables: ['complete the user request'],
    missingInputs: [],
    notes: [],
  };
};

export const parseControllerProfile = (raw: string | null, fallback: ControllerTaskProfile): ControllerTaskProfile => {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    return fallback;
  }

  return {
    summary: parsed.summary.trim(),
    complexity:
      parsed.complexity === 'ambient' || parsed.complexity === 'simple' || parsed.complexity === 'structured'
        ? parsed.complexity
        : fallback.complexity,
    shouldUseSkills: typeof parsed.shouldUseSkills === 'boolean' ? parsed.shouldUseSkills : fallback.shouldUseSkills,
    skillQuery: typeof parsed.skillQuery === 'string' && parsed.skillQuery.trim() ? parsed.skillQuery.trim() : fallback.skillQuery,
    deliverables: sanitizeList(parsed.deliverables, 6).length > 0 ? sanitizeList(parsed.deliverables, 6) : fallback.deliverables,
    missingInputs: sanitizeList(parsed.missingInputs, 6),
    directReply: typeof parsed.directReply === 'string' && parsed.directReply.trim() ? parsed.directReply.trim() : fallback.directReply,
    notes: sanitizeList(parsed.notes, 8),
  };
};

export const buildDecisionPrompt = (input: {
  stateSummary: string;
  workers: WorkerCapability[];
  skills: SkillMetadata[];
  objective?: string;
  dateScope?: string;
  workflowName?: string;
  todoProgress?: string;
  // todoMode=true means the runtime is driving required tools automatically.
  // todoMode=false (default) means the model is the primary decision maker.
  todoMode?: boolean;
}): string => {
  const todoMode = input.todoMode === true;

  const promptLines = [
    // Role
    'You are the controller for a tool-using assistant.',
    'Your job is to decide the single next action.',
    'Return JSON only.',

    // Current context — always populated from state at call site
    [
      'Current context:',
      input.objective    ? `- Objective: ${input.objective}`    : '- Objective: not set',
      input.dateScope    ? `- Date scope: ${input.dateScope}`   : '- Date scope: not set',
      input.workflowName ? `- Workflow: ${input.workflowName}`  : '',
    ].filter(Boolean).join('\n'),

    // Allowed decision shapes
    'Allowed decision JSON shapes:',
    '- {"decision":"CALL_WORKER","invocation":{"workerKey":"...","actionKind":"DISCOVER_CANDIDATES|INSPECT_CANDIDATE|RETRIEVE_ARTIFACT|QUERY_REMOTE_SYSTEM|VERIFY_OUTPUT","input":{...}},"reasoning":"optional"}',
    '- {"decision":"SET_TODOS","requiredTools":["workerKey1","workerKey2"],"reasoning":"optional"}',
    '- {"decision":"REQUEST_LOCAL_ACTION","actionKind":"MUTATE_WORKSPACE|EXECUTE_COMMAND","localAction":{...},"reasoning":"optional"}',
    '- {"decision":"ASK_USER","question":"..."}',
    '- {"decision":"COMPLETE","reply":"..."}',
    '- {"decision":"FAIL","reason":"..."}',

    // Mode-specific guidance — only inject the block that matches current runtime state
    todoMode
      ? [
          'Runtime mode: skill workflow (todo-list active)',
          '- Required tools are dispatched automatically. You are only consulted for optional tools and ASK_USER decisions.',
          '- If optional tools like search or larkDoc are relevant to this specific request, emit CALL_WORKER for the next one.',
          '- If no optional tools are needed, emit COMPLETE.',
        ].join('\n')
      : [
          'Runtime mode: free decision',
          '- Choose the single best next action to move the task forward.',
          '- Reading a skill gives you knowledge only. It does not automatically create an execution plan.',
          '- You may read more than one skill before planning if that helps you understand the workflow.',
          '- When you have enough context for a multi-step workflow, emit SET_TODOS with the worker keys to run in order.',
          '- If the request maps directly to a worker (tasks, meetings, calendar, Zoho, Outreach, docs, search), call that worker directly.',
          '- Do not load a skill unless the user explicitly named one or the request is clearly protocol-heavy.',
          '- If the request is already answerable without tools, emit COMPLETE directly.',
          '- Do not emit FAIL while there is a plausible worker that could gather the first piece of evidence.',
        ].join('\n'),

    // Readiness gate — only relevant in todo mode after a skill just loaded
    todoMode
      ? [
          'Readiness gate (fires once only, before the first worker call after skill load):',
          '- If objective and date scope are both clear, proceed immediately. Do not ask the user anything.',
          '- If either is missing and cannot be inferred, emit one ASK_USER covering all gaps.',
          '- required_inputs in the skill are hints not gates. Infer from the message before asking.',
          '- After the first real worker call, never re-enter this gate.',
        ].join('\n')
      : '',

    // COMPLETE reply rules — always required regardless of mode
    'COMPLETE reply rules — violations are incorrect behavior:',
    '- The reply field must be written as a human assistant responding directly to the user.',
    '- Never include raw JSON, worker key names, system internals like executionId or recordId, or concatenated fact strings.',
    '- Open with a direct answer to what the user asked.',
    '- Group findings by system (Zoho, Lark, Outreach etc.) in clean prose or a simple bullet list.',
    '- Clearly state what was found and what was not found.',
    '- If a tool failed, say so honestly and tell the user what they can do about it.',
    '- End with a concrete next step or offer.',
    '- Good example: "Here\'s what I found for today (March 15): Zoho — one active deal: StrictScope Deal 1 in Qualification (Rs. 65,000). Outreach — 10 publisher matches ready. Lark Tasks — none due today. Lark Calendar — no events. Lark Meetings — could not retrieve (date format error). Want me to add any follow-up tasks?"',
    '- Bad example: "Loaded SKILL.md for daily-stuff { success: true, recordId: ... }"',

    // Workers and skills catalog
    'Available workers:',
    buildWorkerCatalogContext(input.workers),
    'Available skill metadata:',
    buildSkillCatalogContext(input.skills),

    // State summary
    input.stateSummary,

    // Todo progress — always last, maximum recency weight
    input.todoProgress ? `Current progress:\n${input.todoProgress}` : '',
  ];

  return promptLines.filter(Boolean).join('\n\n');
};

export const buildTodoPlanningPrompt = (input: {
  userRequest: string;
  objective?: string;
  dateScope?: string;
  workflowName?: string;
  deliverables: string[];
  workers: WorkerCapability[];
  candidateTools: string[];
  stateSummary: string;
}): string => [
  'You are planning the work list for a tool-using assistant.',
  'Return JSON only.',
  'Your job is to decide the real work items before execution starts.',
  'Reading skills gives knowledge. This step creates the execution plan.',
  'Allowed decision JSON shapes:',
  '- {"decision":"SET_TODOS","requiredTools":["workerKey1","workerKey2"],"reasoning":"optional"}',
  '- {"decision":"ASK_USER","question":"..."}',
  '- {"decision":"COMPLETE","reply":"..."}',
  'Rules:',
  '- If the request clearly needs more than one real worker step, emit SET_TODOS.',
  '- Do not emit CALL_WORKER in this planning step.',
  '- Do not include skills, workspace, or terminal in SET_TODOS. Those are not user work items.',
  '- Do not include unrelated tools just because they exist in a skill.',
  '- Include only the workers actually needed to satisfy the user request.',
  '- Prefer read/query tools before write tools unless the user explicitly asked for a mutation.',
  '- If the request is missing one blocker needed to build the plan, emit one ASK_USER.',
  '- If the request is already answerable without tools, emit COMPLETE.',
  [
    'Current context:',
    input.objective ? `- Objective: ${input.objective}` : '- Objective: not set',
    input.dateScope ? `- Date scope: ${input.dateScope}` : '- Date scope: not set',
    input.workflowName ? `- Workflow: ${input.workflowName}` : '',
  ].filter(Boolean).join('\n'),
  input.deliverables.length > 0 ? `Deliverables: ${input.deliverables.join(' | ')}` : '',
  input.candidateTools.length > 0 ? `Likely worker candidates: ${input.candidateTools.join(', ')}` : '',
  'Available workers:',
  buildWorkerCatalogContext(input.workers),
  input.stateSummary,
  `User request: ${input.userRequest}`,
].filter(Boolean).join('\n\n');

export const buildParamPrompt = (input: {
  workerKey: string;
  actionKind: string;
  contract: string;
  objective: string;
  dateScope?: string;
  skillGuidance?: string;
  previousResults: string[];
  priorKeyData?: string[];
  completedTools: string[];
  toolPurpose?: string;
}): string => [
  'You are generating parameters for a single worker call.',
  `Worker: ${input.workerKey}`,
  `Action kind: ${input.actionKind}`,
  `Worker contract: ${input.contract}`,
  'Context:',
  `- Objective: ${input.objective || 'none provided'}`,
  input.dateScope    ? `- Date scope: ${input.dateScope}`                                                                         : '- Date scope: none provided',
  input.skillGuidance ? `- Skill guidance: ${input.skillGuidance}`                                                                : '',
  input.toolPurpose  ? `- This tool\'s purpose in the workflow: ${input.toolPurpose}`                                             : '',
  input.previousResults.length > 0
    ? `- Previous results:\n${input.previousResults.map((r) => `  - ${r}`).join('\n')}`
    : '- Previous results: none',
  input.priorKeyData && input.priorKeyData.length > 0
    ? `- Relevant prior key data:\n${input.priorKeyData.map((d) => `  - ${d}`).join('\n')}`
    : '- Relevant prior key data: none',
  input.completedTools.length > 0
    ? `Completed tools: ${input.completedTools.join(', ')}`
    : 'Completed tools: none',
  'Return ONLY a JSON object with the parameters for this worker.',
  'This is a read/query step. Do not create, update, schedule, or mutate anything unless the user explicitly asked for that side effect.',
  'Do not explain. Do not add commentary.',
  `Format exactly: {"actionKind":"${input.actionKind}","params":{...}}`,
].filter(Boolean).join('\n\n');

export const buildSynthesisPrompt = (input: {
  workflowName?: string;
  objective: string;
  results: string[];
  failures: string[];
  unresolved: string[];
}): string => [
  'Write the final user-facing answer for a completed task.',
  'Respond directly to the user, not as a workflow report.',
  `Objective: ${input.objective || 'none provided'}`,
  'Results:',
  input.results.length > 0 ? input.results.map((r) => `- ${r}`).join('\n') : '- none',
  'Failed tools (if any):',
  input.failures.length > 0 ? input.failures.map((f) => `- ${f}`).join('\n') : '- none',
  'Unresolved items (never attempted or not confirmed — do NOT claim these were done):',
  input.unresolved.length > 0 ? input.unresolved.map((item) => `- ${item}`).join('\n') : '- none',
  'Rules:',
  '- Do not mention workflow names, skill names, or that you "ran a workflow".',
  '- Do not use headings like "Workflow Status" or phrases like "let\'s break down".',
  '- Do not start with a title, heading, or bold label like "**Today\'s ...**".',
  '- Do not narrate your process with phrases like "Alright" or "I\'ve just checked".',
  '- Start with the findings themselves.',
  '- Be specific — mention actual deal names, task titles, and meeting subjects when available.',
  '- If something failed, say so honestly and tell the user what they can do about it.',
  '- Never say "I scheduled", "I created", "I added", or similar unless that action is confirmed in the Results list above.',
  '- For any unresolved item, say it was not completed and why in one short sentence.',
  '- Prefer short paragraphs. Use bullet points only if there are more than 4 distinct findings.',
  '- Keep the answer concise and operational.',
  'Good style example:',
  'Here’s what I found for today: one cancelled calendar event from 16:30 to 17:30, and 10 Lark tasks, all marked done. If you want, I can turn this into a cleaner summary.',
].filter(Boolean).join('\n\n');

export const buildFollowupIntentPrompt = (input: {
  latestUserTurn: string;
  workflowSummary: string;
  lastFailed?: string;
  lastSuccessful?: string;
}): string => [
  'You are classifying a follow-up message after a workflow run.',
  'Return JSON only.',
  'Allowed JSON:',
  '{"kind":"controller_meta_explain|controller_meta_retry|workflow_continue|new_task","reason":"..."}',
  'Use controller_meta_explain when the user is asking about why something failed, what happened, or to explain the previous run.',
  'Use controller_meta_retry when the user wants the previously failed workflow step retried.',
  'Use workflow_continue when the user is providing new information to continue the same workflow.',
  'Use new_task when the user is asking for a fresh external task that should be handled normally.',
  `Workflow summary: ${input.workflowSummary}`,
  input.lastFailed     ? `Last failed step: ${input.lastFailed}`         : 'Last failed step: none',
  input.lastSuccessful ? `Last successful step: ${input.lastSuccessful}` : 'Last successful step: none',
  `Latest user turn: ${input.latestUserTurn}`,
].filter(Boolean).join('\n\n');

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
