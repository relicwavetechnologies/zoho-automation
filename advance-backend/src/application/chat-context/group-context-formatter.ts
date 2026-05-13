import type { GroupChatWindow, GroupChatMessage, GroupChatSummary } from '../../domain/conversation/group-context';
import { GROUP_CONTEXT_POLICY } from '../../domain/conversation/group-context-policy';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 24;
}

function truncateToBudget(text: string, tokenBudget: number): string {
  if (estimateTokens(text) <= tokenBudget) return text;
  const maxChars = Math.max(80, tokenBudget * 4 - 80);
  return `${text.slice(0, maxChars).trimEnd()}... [truncated]`;
}

function addBudgetedLine(lines: string[], line: string, state: { tokens: number; budget: number }): boolean {
  const tokens = estimateTokens(line);
  if (state.tokens + tokens <= state.budget) {
    lines.push(line);
    state.tokens += tokens;
    return true;
  }

  if (state.tokens >= state.budget) return false;

  const remaining = state.budget - state.tokens;
  if (remaining <= 20) return false;
  lines.push(truncateToBudget(line, remaining));
  state.tokens = state.budget;
  return false;
}

function addArraySection(
  lines: string[],
  state: { tokens: number; budget: number },
  label: string,
  values: readonly string[] | undefined,
): void {
  if (!values || values.length === 0) return;
  addBudgetedLine(lines, `${label}: ${values.join('; ')}`, state);
}

function asSummaryArray(values: readonly string[] | undefined): readonly string[] {
  return Array.isArray(values) ? values : [];
}

function formatSummary(summary: GroupChatSummary, tokenBudget = GROUP_CONTEXT_POLICY.SUMMARY_CONTEXT_TOKEN_BUDGET): string {
  const lines: string[] = [];
  const state = { tokens: 0, budget: tokenBudget };

  if (summary.summary) addBudgetedLine(lines, `Summary: ${summary.summary}`, state);
  if (summary.latestObjective) addBudgetedLine(lines, `Current objective: ${summary.latestObjective}`, state);
  if (summary.latestDirection) addBudgetedLine(lines, `Latest direction: ${summary.latestDirection}`, state);
  addArraySection(lines, state, 'Decisions', asSummaryArray(summary.decisions));
  addArraySection(lines, state, 'Open questions', asSummaryArray(summary.openQuestions));
  addArraySection(lines, state, 'Owners', asSummaryArray(summary.owners));
  addArraySection(lines, state, 'Deadlines', asSummaryArray(summary.deadlines));
  addArraySection(lines, state, 'Key entities', asSummaryArray(summary.activeEntities));
  addArraySection(lines, state, 'Files and links', asSummaryArray(summary.mentionedResources));
  addArraySection(lines, state, 'Completed actions', asSummaryArray(summary.completedActions));
  addArraySection(lines, state, 'Constraints', asSummaryArray(summary.constraints));
  addArraySection(lines, state, 'Blockers', asSummaryArray(summary.blockers));
  addArraySection(lines, state, 'User goals', asSummaryArray(summary.userGoals));
  addArraySection(lines, state, 'Superseded', asSummaryArray(summary.superseded));

  return lines.join('\n');
}

function formatTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return date.toISOString();
}

function formatMessage(msg: GroupChatMessage): string {
  const prefix = msg.role === 'assistant' ? '@Divo' : msg.senderName;
  const mention = msg.botMentioned ? ' @Divo' : '';
  let line = `[${formatTimestamp(msg.createdAt)}] ${prefix}${mention}: ${msg.content}`;
  if (msg.attachedFiles && msg.attachedFiles.length > 0) {
    line += ` [files: ${msg.attachedFiles.join(', ')}]`;
  }
  return line;
}

export function selectRecentMessagesForTranscript(
  messages: readonly GroupChatMessage[],
  tokenBudget = GROUP_CONTEXT_POLICY.RAW_TRANSCRIPT_TOKEN_BUDGET,
): GroupChatMessage[] {
  if (tokenBudget <= 0) return [];
  const selected: GroupChatMessage[] = [];
  let tokenCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    const tokens = estimateTokens(formatMessage(msg));
    if (selected.length > 0 && tokenCount + tokens > tokenBudget) break;
    selected.push(msg);
    tokenCount += tokens;
    if (tokenCount >= tokenBudget) break;
  }

  return selected.reverse();
}

function formatTranscriptLines(
  messages: readonly GroupChatMessage[],
  tokenBudget = GROUP_CONTEXT_POLICY.RAW_TRANSCRIPT_TOKEN_BUDGET,
): string[] {
  if (tokenBudget <= 0) return [];

  const lines: string[] = [];
  let tokenCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    const line = formatMessage(msg);
    const tokens = estimateTokens(line);

    if (lines.length > 0 && tokenCount + tokens > tokenBudget) break;

    if (tokenCount + tokens > tokenBudget) {
      lines.push(truncateToBudget(line, tokenBudget - tokenCount));
      tokenCount = tokenBudget;
      break;
    }

    lines.push(line);
    tokenCount += tokens;
  }

  return lines.reverse();
}

export function formatGroupContextForPrompt(window: GroupChatWindow): string {
  const sections: string[] = [
    'GROUP CHAT CONTEXT - Background from this Lark group chat.',
    'Treat this as room context, not as the direct user/assistant conversation. The current user message is still the active request.',
  ];

  if (window.summary) {
    const summaryText = formatSummary(window.summary);
    if (summaryText) {
      sections.push('');
      sections.push('[Rolling summary of older group discussion]');
      sections.push(summaryText);
    }
  }

  const transcriptLines = formatTranscriptLines(window.recentMessages);
  if (transcriptLines.length > 0) {
    sections.push('');
    sections.push(`[Recent raw group transcript - latest ${transcriptLines.length} messages within ~${GROUP_CONTEXT_POLICY.RAW_TRANSCRIPT_TOKEN_BUDGET} tokens]`);
    sections.push(...transcriptLines);
  }

  return sections.join('\n');
}
