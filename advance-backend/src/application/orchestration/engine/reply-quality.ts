import { stripTraceMarker } from './execution-summary';

const TRACE_RE = /\n?<!--TOOL_TRACE:[\s\S]*?-->/g;
const HAS_TABLE_RE = /\|.+\|\s*\n\s*\|[-:\s|]+\|/;
const LARK_TASK_INTENT_RE = /\b(lark\s+tasks?|tasks?\s+in\s+lark|make\s+lark\s+tasks?|create\s+lark\s+tasks?)\b/i;
const FUTURE_ACTION_RE = /\b(i will|i'll|will create|will proceed|i can|would you like me to|i will need to)\b/i;
const LOSSY_PHRASES_RE = /\b(provided above|listed above|retrieved the list|started the review|have started|will proceed|will need to pull|have been created in your lark account)\b/i;

export interface ReplyQualityInput {
  readonly userMessage: string;
  readonly replyText: string;
  readonly toolsCalled: readonly string[];
  readonly toolResults: ReadonlyArray<{ toolName: string; output: string }>;
}

export interface ReplyQualityAssessment {
  readonly needsSynthesis: boolean;
  readonly reasons: readonly string[];
  readonly createdTaskTitles: readonly string[];
  readonly larkTaskIntent: boolean;
  readonly internalOnlyChecklist: boolean;
}

export function cleanReplyText(replyText: string): string {
  return replyText.replace(TRACE_RE, '').trim();
}

export function assessReplyQuality(input: ReplyQualityInput): ReplyQualityAssessment {
  const cleanReply = cleanReplyText(input.replyText);
  const toolsCalled = new Set(input.toolsCalled);
  const resultText = input.toolResults.map(r => r.output).join('\n');
  const createdTaskTitles = extractCreatedTaskTitles(resultText);
  const larkTaskIntent = LARK_TASK_INTENT_RE.test(input.userMessage);
  const calledLark = [...toolsCalled].some(isLarkTaskCapableTool);
  const calledOnlyInternalChecklist = toolsCalled.has('manageTodos') && !calledLark;
  const hasTable = HAS_TABLE_RE.test(cleanReply);

  const reasons: string[] = [];
  if (input.toolsCalled.length === 0) {
    return {
      needsSynthesis: false,
      reasons,
      createdTaskTitles,
      larkTaskIntent,
      internalOnlyChecklist: false,
    };
  }

  if (!cleanReply || cleanReply === 'Done.' || cleanReply.length < 15) {
    reasons.push('empty_or_trivial_reply');
  }

  if (cleanReply.length < 400 && LOSSY_PHRASES_RE.test(cleanReply) && !hasTable) {
    reasons.push('lossy_generic_reply');
  }

  if (createdTaskTitles.length > 0) {
    const missingTitles = createdTaskTitles.filter(title => !includesLoose(cleanReply, title));
    if (missingTitles.length > 0) {
      reasons.push(`missing_created_task_titles:${missingTitles.join(', ')}`);
    }
    if (FUTURE_ACTION_RE.test(cleanReply)) {
      reasons.push('future_tense_after_completed_actions');
    }
  }

  if (larkTaskIntent && calledOnlyInternalChecklist) {
    reasons.push('lark_task_intent_only_internal_checklist');
  }

  return {
    needsSynthesis: reasons.length > 0,
    reasons,
    createdTaskTitles,
    larkTaskIntent,
    internalOnlyChecklist: larkTaskIntent && calledOnlyInternalChecklist,
  };
}

export function buildPresentationContext(input: ReplyQualityInput): string {
  const sections = input.toolResults.map(result => {
    const role = result.toolName === 'manageTodos'
      ? 'INTERNAL Divo checklist/progress only. This is NOT a Lark Task and is not visible as a Lark task.'
      : isLarkTaskCapableTool(result.toolName)
        ? 'External/user-visible Lark-capable action result.'
        : 'Tool/action result.';
    const output = stripTraceMarker(result.output);
    return [
      `[${result.toolName}]`,
      `Role: ${role}`,
      `Result:\n${output}`,
    ].join('\n');
  });

  return sections.join('\n\n---\n\n') || '(no tool data returned)';
}

export function buildCompactPresentationContext(input: ReplyQualityInput): string {
  const unique = new Map<string, { toolName: string; output: string }>();
  for (const result of input.toolResults) {
    const output = stripTraceMarker(result.output).trim();
    unique.set(`${result.toolName}\n${output}`, { toolName: result.toolName, output });
  }
  const results = [...unique.values()];
  const withLinks = results.filter(result => /https?:\/\//i.test(result.output));
  const tail = results.filter(result => !withLinks.includes(result)).slice(-12);
  return buildPresentationContext({
    ...input,
    toolResults: [...withLinks, ...tail].map(result => ({
      ...result,
      output: result.output.slice(0, 4_000),
    })),
  }).slice(0, 16_000);
}

export function buildDeterministicRecoveryReply(toolResults: ReplyQualityInput['toolResults']): string {
  const urls = new Set<string>();
  for (const result of toolResults) {
    for (const match of stripTraceMarker(result.output).matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
      urls.add(match[0]!.replace(/[),.;]+$/, ''));
    }
  }
  if (urls.size > 0) {
    return `I completed the requested work.\n\n${[...urls].map(url => `Result: ${url}`).join('\n')}`;
  }
  return 'I completed the requested work, but the detailed completion summary could not be generated.';
}

function isLarkTaskCapableTool(toolName: string): boolean {
  return toolName === 'larkTask'
    || toolName === 'larkAgent'
    || toolName === 'agent_lark_ops';
}

function extractCreatedTaskTitles(text: string): string[] {
  const titles = new Set<string>();
  const patterns = [
    /Task\s+"([^"]+)"\s+has been created/gi,
    /Created\s+(?:Lark\s+)?task\s+[":]\s*"?([^"\n.]+)"?/gi,
    /Added task\s+[":]\s*"?([^"\n.]+)"?/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const title = normalizeTitle(match[1] ?? '');
      if (title) titles.add(title);
    }
  }
  return [...titles];
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

function includesLoose(haystack: string, needle: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return normalize(haystack).includes(normalize(needle));
}
