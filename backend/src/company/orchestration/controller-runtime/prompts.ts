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
    shouldUseSkills: /\b(daily-stuff|workflow|process|protocol|playbook|skill)\b/i.test(trimmed),
    skillQuery: /\b(daily-stuff)\b/i.test(trimmed) ? 'daily-stuff' : trimmed,
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
}): string => {
  const promptLines = [
    'You are the single controller for this assistant.',
    'Return JSON only.',
    'You have tools/workers available. Solve simple requests directly when possible.',
    'For complex or protocol-heavy work, inspect skill metadata first instead of blindly loading skills.',
    'If a skill looks relevant, fetch and read the full SKILL.md.',
    'Use the skill as workflow guidance, not as a replacement for tool reality.',
    'If required inputs are missing, ask one focused question.',
    'After every tool or worker result, reconsider the next step.',
    'Continue until done or genuinely blocked.',
    'Allowed decision JSON shapes:',
    '- {"decision":"CALL_WORKER","invocation":{"workerKey":"...","actionKind":"DISCOVER_CANDIDATES|INSPECT_CANDIDATE|RETRIEVE_ARTIFACT|QUERY_REMOTE_SYSTEM|VERIFY_OUTPUT","input":{...}},"reasoning":"optional"}',
    '- {"decision":"REQUEST_LOCAL_ACTION","actionKind":"MUTATE_WORKSPACE|EXECUTE_COMMAND","localAction":{...},"reasoning":"optional"}',
    '- {"decision":"ASK_USER","question":"..."}',
    '- {"decision":"COMPLETE","reply":"..."}',
    '- {"decision":"FAIL","reason":"..."}',
    'Completion policy (read before emitting COMPLETE):',
    '- "All outputs verified" means the check system is satisfied. It does NOT mean the workflow is done. The check system only tracks infrastructure (skill loaded, inputs present, evidence exists). It does not track whether you have queried all relevant systems.',
    '- Before emitting COMPLETE for any skill-based workflow, you must have attempted every worker listed in the skill\'s allowed_tools that could plausibly return relevant data. One worker result, even a good one, is not enough to complete a multi-system workflow.',
    '- If the SKILL.md lists 6 allowed_tools and you have only called 1, you are not done. Call the remaining ones.',
    '- An empty result like "No X found" still counts as attempted. You do not need to retry empty results.',
    '- A failed worker result should be retried once if the failure looks transient, then counted as attempted.',
    '- Only emit COMPLETE when either: (a) all allowed_tools have been attempted, OR (b) you have enough grounded data to fully answer the user\'s request AND the remaining tools are clearly irrelevant to this specific request.',
    '- For the daily-stuff skill specifically, allowed_tools are: zoho, outreach, search, larkDoc, larkTask, larkCalendar, larkMeeting.',
    '- You must attempt all of them before completing unless one is clearly irrelevant. For example, do not create a larkDoc unless the user asked for one.',
    'Rules:',
    '- Do not choose a worker unless it can realistically move the task forward.',
    '- If the request is already answerable without tools, COMPLETE directly.',
    '- Do not load full skill documents unless metadata suggests they are relevant.',
    '- For the skills worker, DISCOVER_CANDIDATES must use input {"query":"..."} and RETRIEVE_ARTIFACT must use input {"id":"..."} where id comes from skill metadata.',
    '- If the available skill metadata already contains an exact matching skill id or name, skip DISCOVER_CANDIDATES and go directly to RETRIEVE_ARTIFACT.',
    '- Do not claim a side effect succeeded unless a worker or local action actually succeeded.',
    '- Do not emit FAIL while there is still a plausible non-local worker that could gather the first piece of evidence.',
    '- If no grounded evidence exists yet and no blocking inputs are missing, prefer CALL_WORKER over ASK_USER or FAIL.',
    '- For concrete requests that already map to a worker (for example tasks, meetings, calendar, Zoho, Outreach, docs, or search), do the worker call directly instead of loading a skill unless the user explicitly asked for a named skill or workflow.',
    'Skill execution rules (apply when a SKILL.md is loaded):',
    '- required_inputs in the skill spec are NOT hard gates. They are hints about what the skill needs to do useful work.',
    '- Before asking the user for any required_input, check if it can be reasonably inferred from the conversation.',
    '- objective: if the user explicitly named a skill, the objective IS the standard execution of that skill. Do not ask for it. Infer objective = "run the [skill-name] workflow for [date_scope]".',
    '- date_scope: if the user said "today", "this week", "yesterday", or any clear time reference, infer it directly. Do not ask.',
    '- stakeholders: optional. Never ask unless the next real step genuinely requires specific people.',
    '- delivery_style: optional. Never ask unless the user expressed a preference or the next real step requires it.',
    '- Only emit ASK_USER if a required_input cannot be inferred AND its absence would cause the very next worker call to fail or return meaningless results.',
    '- If inputs can be inferred, proceed to the first real worker step immediately. For an operational workflow skill, the first real step is usually querying internal systems to gather context.',
    'Readiness gate (apply once, after SKILL.md is loaded, before first real worker call):',
    '- After loading a SKILL.md, before calling any non-skills worker, run a silent readiness check.',
    '- Ask yourself: (1) do I know the objective, (2) do I know the scope such as date or time range, and (3) do I have enough context to make the first worker call return something useful?',
    '- If all of those are answerable, proceed directly to the first worker call and do not ask the user anything.',
    '- If any of them cannot be answered and the gap would make worker calls meaningless, emit one ASK_USER that covers all missing context in a single focused question.',
    '- Do not ask about optional fields. Do not ask about things you can infer. Do not ask more than once.',
    '- The readiness gate fires only once per workflow execution. After the first real worker call, never re-enter it.',
    'COMPLETE reply rules (mandatory — violations are incorrect behavior):',
    '- The reply field in {"decision":"COMPLETE","reply":"..."} must be written as if you are a human assistant responding directly to the user. It must never contain raw JSON strings or objects, worker summary strings like "Loaded SKILL.md for daily-stuff", system internals like workerKey, actionKind, executionId, or recordId, or concatenated facts without structure or prose.',
    '- The reply must open with a direct answer to what the user asked.',
    '- The reply must present findings in clean readable prose or a simple bullet list.',
    '- The reply must group findings by system such as Zoho, Lark, and Outreach.',
    '- The reply must clearly state what was found and what was not found.',
    '- The reply must end with a concrete next step or offer.',
    '- Transform worker results before using them: if a worker returned JSON, extract the human-readable summary field only; if a worker returned "No X found", say "No X found for today" in prose; if a worker returned a real record, describe it in one sentence.',
    '- The reply should look like: "Here\'s what I found for today (March 15): Zoho — One active deal: StrictScope Deal 1 in Qualification stage (Rs. 65,000), contact: Vabhi StrictScope. Outreach — 10 publisher matches ready for today\'s campaigns. Lark Tasks — No tasks due today. Lark Calendar — No events scheduled for today. Lark Meetings — No meetings found for today. Everything looks clear. Want me to create a daily summary doc or add any follow-up tasks based on this?"',
    '- The reply must NEVER look like this: "Loaded SKILL.md for daily-stuff { success: true, recordId: ... }".',
    'Available workers:',
    buildWorkerCatalogContext(input.workers),
    'Available skill metadata:',
    buildSkillCatalogContext(input.skills),
    input.stateSummary,
  ];

  return promptLines.join('\n\n');
};

export const buildParamPrompt = (input: {
  workerKey: string;
  actionKind: string;
  contract: string;
  objective: string;
  dateScope?: string;
  skillGuidance?: string;
  previousResults: string[];
  completedTools: string[];
  toolPurpose?: string;
}): string => [
  'You are generating parameters for a single worker call.',
  `Worker: ${input.workerKey}`,
  `Action kind: ${input.actionKind}`,
  `Worker contract: ${input.contract}`,
  'Context:',
  `- Objective: ${input.objective || 'none provided'}`,
  input.dateScope ? `- Date scope: ${input.dateScope}` : '- Date scope: none provided',
  input.skillGuidance ? `- Skill guidance: ${input.skillGuidance}` : '',
  input.toolPurpose ? `- This tool's purpose in the workflow: ${input.toolPurpose}` : '',
  input.previousResults.length > 0
    ? `- Previous results:\n${input.previousResults.map((item) => `  - ${item}`).join('\n')}`
    : '- Previous results: none',
  input.completedTools.length > 0
    ? `Completed tools: ${input.completedTools.join(', ')}`
    : 'Completed tools: none',
  'Return ONLY a JSON object with the parameters for this worker.',
  'Do not explain. Do not add commentary.',
  `Format exactly: {"actionKind":"${input.actionKind}","params":{...}}`,
].filter(Boolean).join('\n\n');

export const buildSynthesisPrompt = (input: {
  workflowName?: string;
  objective: string;
  results: string[];
  failures: string[];
}): string => [
  'You have completed a workflow. Summarize the results for the user.',
  input.workflowName ? `Workflow: ${input.workflowName}` : '',
  `Objective: ${input.objective || 'none provided'}`,
  'Results:',
  input.results.length > 0 ? input.results.map((item) => `- ${item}`).join('\n') : '- none',
  'Failed tools (if any):',
  input.failures.length > 0 ? input.failures.map((item) => `- ${item}`).join('\n') : '- none',
  'Write a natural language summary. Be specific. Mention actual data such as deal names, task titles, or meeting subjects.',
  'If something failed, say so honestly and what the user can do about it.',
  'Do not use bullet points unless listing more than 4 items.',
  'Do not start with "I have completed...".',
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
