/**
 * Debug run log — writes a super-detailed trace of every agentic run
 * to `latest-agent-run.log` at the project root. Overwritten each run.
 *
 * Activated by env: DEBUG_AGENT_RUN=true
 */

import { writeFileSync, appendFileSync } from 'fs';
import { resolve } from 'path';

const LOG_PATH = resolve(process.cwd(), 'latest-agent-run.log');
let enabled: boolean | null = null;

function isEnabled(): boolean {
  if (enabled === null) {
    const val = process.env['DEBUG_AGENT_RUN'];
    enabled = val === 'true' || val === '1';
  }
  return enabled;
}

function ts(): string {
  return new Date().toISOString();
}

function separator(label: string): string {
  const line = '═'.repeat(80);
  return `\n${line}\n  ${label}\n${line}\n`;
}

function subSeparator(label: string): string {
  const line = '─'.repeat(60);
  return `\n${line}\n  ${label}\n${line}\n`;
}

/** Start a new run — overwrites the log file */
export function debugRunStart(data: {
  chatId: string;
  userId: string;
  companyId: string;
  userMessage: string;
  traceId?: string;
}): void {
  if (!isEnabled()) return;
  const content = [
    separator(`NEW AGENTIC RUN — ${ts()}`),
    `Chat ID:    ${data.chatId}`,
    `User ID:    ${data.userId}`,
    `Company ID: ${data.companyId}`,
    `Trace ID:   ${data.traceId ?? 'none'}`,
    ``,
    subSeparator('USER MESSAGE'),
    data.userMessage,
    '',
  ].join('\n');
  writeFileSync(LOG_PATH, content, 'utf-8');
}

/** Append a section to the log */
function append(text: string): void {
  if (!isEnabled()) return;
  try { appendFileSync(LOG_PATH, text + '\n', 'utf-8'); } catch {}
}

/** Log permission resolution */
export function debugPermissions(data: {
  allowedToolCount: number;
  allowedToolIds: string[];
  hasDepartment: boolean;
  departmentName?: string | undefined;
}): void {
  append([
    subSeparator(`PERMISSIONS — ${ts()}`),
    `Allowed tool count: ${data.allowedToolCount}`,
    `Allowed tool IDs:   ${data.allowedToolIds.join(', ')}`,
    `Has department:     ${data.hasDepartment}`,
    `Department:         ${data.departmentName ?? 'none'}`,
  ].join('\n'));
}

/** Log conversation history loaded */
export function debugHistory(data: {
  turnCount: number;
  truncated: boolean;
  tokenEstimate: number;
  turns: Array<{ role: string; content: string }>;
}): void {
  append([
    subSeparator(`CONVERSATION HISTORY — ${ts()}`),
    `Turn count:     ${data.turnCount}`,
    `Truncated:      ${data.truncated}`,
    `Token estimate: ${data.tokenEstimate}`,
    '',
    ...data.turns.map((t, i) =>
      `--- Turn ${i + 1} [${t.role}] ---\n${t.content}\n`
    ),
  ].join('\n'));
}

/** Log memory context */
export function debugMemoryContext(memoryContext: string): void {
  append([
    subSeparator(`MEMORY CONTEXT — ${ts()}`),
    memoryContext || '(empty — no memories injected)',
  ].join('\n'));
}

/** Log group context */
export function debugGroupContext(groupContext: string | undefined): void {
  append([
    subSeparator(`GROUP CONTEXT — ${ts()}`),
    groupContext || '(empty — DM or no group context)',
  ].join('\n'));
}

/** Log history loading details — poison filter, cache, source */
export function debugHistoryLoad(data: {
  rawCount: number;
  afterPoisonFilter: number;
  afterBudget: number;
  poisonedDropped: Array<{ role: string; contentPreview: string; reason: string }>;
  source: string;
}): void {
  const lines = [
    subSeparator(`HISTORY LOAD DETAILS — ${ts()}`),
    `Source:              ${data.source}`,
    `Raw turns from DB:   ${data.rawCount}`,
    `After poison filter: ${data.afterPoisonFilter}`,
    `After budget cap:    ${data.afterBudget}`,
  ];
  if (data.poisonedDropped.length > 0) {
    lines.push(`\nPoisoned turns DROPPED (${data.poisonedDropped.length}):`);
    data.poisonedDropped.forEach((d, i) => {
      lines.push(`  ${i + 1}. [${d.role}] "${d.contentPreview}" — reason: ${d.reason}`);
    });
  } else {
    lines.push(`Poisoned turns dropped: 0`);
  }
  append(lines.join('\n'));
}

/** Log supervisor setup */
export function debugSupervisorSetup(data: {
  systemPrompt: string;
  tools: Array<{ name: string; description: string }>;
  model: { provider: string; modelId: string; source: string };
  maxSteps: number;
  temperature: number;
  messages: Array<{ role: string; content: string }>;
}): void {
  append([
    separator(`SUPERVISOR SETUP — ${ts()}`),
    `Model:       ${data.model.provider}/${data.model.modelId} (${data.model.source})`,
    `Max steps:   ${data.maxSteps}`,
    `Temperature: ${data.temperature}`,
    `Tool count:  ${data.tools.length}`,
    '',
    subSeparator(`TOOL DEFINITIONS (${data.tools.length})`),
    ...data.tools.map((t, i) =>
      `  ${i + 1}. ${t.name}\n     Description: ${t.description}\n`
    ),
    subSeparator('SYSTEM PROMPT'),
    data.systemPrompt,
    '',
    subSeparator(`MESSAGES (${data.messages.length})`),
    ...data.messages.map((m, i) =>
      `--- Message ${i + 1} [${m.role}] ---\n${m.content}\n`
    ),
  ].join('\n'));
}

/** Log a tool call from the supervisor stream */
export function debugToolCall(data: {
  toolName: string;
  args: unknown;
  step?: number;
}): void {
  append([
    subSeparator(`TOOL CALL: ${data.toolName} — ${ts()}`),
    `Step: ${data.step ?? '?'}`,
    `Args: ${JSON.stringify(data.args, null, 2)}`,
  ].join('\n'));
}

/** Log a tool result from the supervisor stream */
export function debugToolResult(data: {
  toolName: string;
  output: string;
  durationMs?: number | undefined;
  isError: boolean;
}): void {
  append([
    subSeparator(`TOOL RESULT: ${data.toolName} ${data.isError ? '❌ ERROR' : '✓'} — ${ts()}`),
    `Duration: ${data.durationMs ?? '?'}ms`,
    `Length:   ${data.output.length} chars`,
    ``,
    data.output,
  ].join('\n'));
}

/** Log supervisor text generated during streaming */
export function debugSupervisorText(text: string): void {
  append([
    subSeparator(`SUPERVISOR TEXT OUTPUT — ${ts()}`),
    `Length: ${text.length} chars`,
    `Empty:  ${!text.trim()}`,
    ``,
    text || '(empty)',
  ].join('\n'));
}

/** Log the final reply decision */
export function debugFinalReply(data: {
  finalText: string;
  source: string;
  toolsCalled: string[];
  toolResultCount: number;
}): void {
  append([
    separator(`FINAL REPLY — ${ts()}`),
    `Source:       ${data.source}`,
    `Tools called: ${data.toolsCalled.join(', ') || 'none'}`,
    `Tool results: ${data.toolResultCount}`,
    `Reply length: ${data.finalText.length}`,
    ``,
    data.finalText,
  ].join('\n'));
}

/** Log specialist agent start */
export function debugAgentStart(data: {
  agentSlug: string;
  task: string;
  toolCount: number;
  toolNames: string[];
  depth: number;
  model: string;
  systemPrompt: string;
}): void {
  append([
    separator(`AGENT START: ${data.agentSlug} (depth ${data.depth}) — ${ts()}`),
    `Task:  ${data.task}`,
    `Model: ${data.model}`,
    `Tools (${data.toolCount}): ${data.toolNames.join(', ')}`,
    '',
    subSeparator(`AGENT SYSTEM PROMPT: ${data.agentSlug}`),
    data.systemPrompt,
  ].join('\n'));
}

/** Log specialist agent result */
export function debugAgentResult(data: {
  agentSlug: string;
  status: string;
  result: string;
  durationMs: number;
  steps?: Array<{
    toolCalls?: Array<{ toolName: string; args?: unknown }>;
    toolResults?: Array<{ toolName?: string; output?: unknown }>;
  }>;
}): void {
  const lines = [
    separator(`AGENT RESULT: ${data.agentSlug} [${data.status}] — ${ts()}`),
    `Duration: ${data.durationMs}ms`,
    `Result length: ${data.result.length}`,
  ];

  if (data.steps) {
    lines.push('', subSeparator(`INTERNAL STEPS (${data.steps.length})`));
    for (let s = 0; s < data.steps.length; s++) {
      const step = data.steps[s]!;
      if (step.toolCalls) {
        for (let t = 0; t < step.toolCalls.length; t++) {
          const tc = step.toolCalls[t]!;
          const tr = step.toolResults?.[t];
          const output = tr?.output != null ? String(tr.output) : '';
          const isErr = output.startsWith('error:');
          const tcArgs = (tc as any).args ?? (tc as any).input ?? (tc as any).parameters ?? null;
          lines.push(`  Step ${s + 1} / Tool ${t + 1}: ${tc.toolName} ${isErr ? '❌' : '✓'}`);
          lines.push(`    Args: ${tcArgs ? JSON.stringify(tcArgs, null, 2) : '(none — keys on tc: ' + Object.keys(tc as any).join(', ') + ')'}`);
          lines.push(`    Result (${output.length} chars): ${output.slice(0, 500)}`);
          if (output.length > 500) lines.push(`    ... [truncated ${output.length - 500} more chars]`);
        }
      }
    }
  }

  lines.push('', subSeparator(`FULL AGENT REPLY: ${data.agentSlug}`), data.result);
  append(lines.join('\n'));
}

/** Log every stream chunk type for full supervisor lifecycle visibility */
export function debugStreamChunk(data: {
  chunkType: string;
  stepIndex: number;
  detail?: string;
}): void {
  append(`  [stream] step=${data.stepIndex} type=${data.chunkType}${data.detail ? ' | ' + data.detail : ''}`);
}

/** Log stream start */
export function debugStreamStart(): void {
  append([
    subSeparator(`SUPERVISOR STREAM STARTED — ${ts()}`),
    '  Logging every chunk from fullStream...',
  ].join('\n'));
}

/** Log stream end with full summary of what happened */
export function debugStreamEnd(data: {
  totalChunks: number;
  stepCount: number;
  textLength: number;
  toolCallCount: number;
  toolResultCount: number;
  toolCalls: string[];
  toolResults: Array<{ toolName: string; outputLength: number; isError: boolean }>;
  finishReason?: string;
}): void {
  append([
    subSeparator(`SUPERVISOR STREAM ENDED — ${ts()}`),
    `Total chunks:   ${data.totalChunks}`,
    `Steps:          ${data.stepCount}`,
    `Text length:    ${data.textLength}`,
    `Tool calls:     ${data.toolCallCount} [${data.toolCalls.join(', ')}]`,
    `Tool results:   ${data.toolResultCount}`,
    `Finish reason:  ${data.finishReason ?? 'unknown'}`,
    '',
    ...data.toolResults.map((r, i) =>
      `  Result ${i + 1}: ${r.toolName} | ${r.outputLength} chars | ${r.isError ? 'ERROR' : 'ok'}`
    ),
  ].join('\n'));
}

/** Log the reply decision logic */
export function debugReplyDecision(data: {
  path: string;
  reason: string;
  supervisorTextLength: number;
  agentResultCount: number;
  agentResultLengths: number[];
  finalTextLength: number;
  finalTextPreview: string;
}): void {
  append([
    subSeparator(`REPLY DECISION — ${ts()}`),
    `Path chosen:          ${data.path}`,
    `Reason:               ${data.reason}`,
    `Supervisor text:      ${data.supervisorTextLength} chars`,
    `Agent results:        ${data.agentResultCount} (lengths: [${data.agentResultLengths.join(', ')}])`,
    `Final text:           ${data.finalTextLength} chars`,
    `Preview:              ${data.finalTextPreview.slice(0, 300)}`,
  ].join('\n'));
}

/** Log supervisor.run() entry — which execution path is taken. */
export function debugSupervisorEntry(data: {
  path: 'governed_lark' | 'dynamic_graph' | 'legacy';
  dynamicGraphEnabled: boolean;
  hasAgentCatalogCache: boolean;
  hasMem0: boolean;
  hasApprovalGate: boolean;
  hasMemoryContext: boolean;
  hasGroupContext: boolean;
  historyTurnCount: number;
  permittedToolCount: number;
}): void {
  append([
    separator(`SUPERVISOR ENTRY — ${ts()}`),
    `Path:                ${data.path}`,
    `Dynamic graph on:    ${data.dynamicGraphEnabled}`,
    `Agent catalog cache: ${data.hasAgentCatalogCache}`,
    `Mem0:                ${data.hasMem0}`,
    `Approval gate:       ${data.hasApprovalGate}`,
    `Memory context:      ${data.hasMemoryContext}`,
    `Group context:       ${data.hasGroupContext}`,
    `History turns:       ${data.historyTurnCount}`,
    `Permitted tools:     ${data.permittedToolCount}`,
  ].join('\n'));
}

/** Log the graph.invoke input — what goes into the LangGraph */
export function debugGraphInvoke(data: {
  userMessage: string;
  conversationHistory: Array<{ role: string; content: string }>;
  companyId: string;
  memoryContext: string;
  groupContext: string;
  chatId: string | null;
  permittedToolCount: number;
}): void {
  append([
    subSeparator(`GRAPH INVOKE INPUT — ${ts()}`),
    `User message:     ${data.userMessage.slice(0, 200)}`,
    `Company ID:       ${data.companyId}`,
    `Chat ID:          ${data.chatId ?? 'null'}`,
    `Memory context:   ${data.memoryContext ? data.memoryContext.length + ' chars' : '(empty)'}`,
    `Group context:    ${data.groupContext ? data.groupContext.length + ' chars' : '(empty)'}`,
    `History turns:    ${data.conversationHistory.length}`,
    `Permitted tools:  ${data.permittedToolCount}`,
    '',
    ...data.conversationHistory.map((m, i) =>
      `  History[${i}] [${m.role}]: ${m.content.slice(0, 150)}${m.content.length > 150 ? '...' : ''}`
    ),
  ].join('\n'));
}

/** Log the graph output — what the LangGraph returned */
export function debugGraphOutput(data: {
  status: string;
  supervisorResult: string | null;
  toolCallsMade: string[];
  error: string | null;
}): void {
  append([
    subSeparator(`GRAPH OUTPUT — ${ts()}`),
    `Status:           ${data.status}`,
    `Tool calls made:  [${data.toolCallsMade.join(', ')}]`,
    `Error:            ${data.error ?? 'none'}`,
    `Result length:    ${data.supervisorResult?.length ?? 0}`,
    `Result preview:   ${(data.supervisorResult ?? '(null)').slice(0, 300)}`,
  ].join('\n'));
}

/** Log run completion */
export function debugRunEnd(data: {
  durationMs: number;
  finalReply: string;
  toolsCalled: string[];
}): void {
  append([
    separator(`RUN COMPLETE — ${ts()}`),
    `Total duration: ${data.durationMs}ms`,
    `Tools called:   ${data.toolsCalled.join(', ') || 'none'}`,
    `Final reply:    ${data.finalReply.slice(0, 200)}`,
    '',
    '═'.repeat(80),
  ].join('\n'));
}
