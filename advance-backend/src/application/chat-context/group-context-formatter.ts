import type {
  GroupChatAttachmentContext,
  GroupChatWindow,
  GroupChatMessage,
  GroupChatSummary,
} from '../../domain/conversation/group-context';
import { GROUP_CONTEXT_POLICY } from '../../domain/conversation/group-context-policy';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 24;
}

function truncateToBudget(text: string, tokenBudget: number): string {
  if (estimateTokens(text) <= tokenBudget) return text;
  const maxChars = Math.max(80, tokenBudget * 4 - 80);
  return `${text.slice(0, maxChars).trimEnd()}... [truncated]`;
}

function asSummaryArray(values: readonly string[] | undefined): readonly string[] {
  return Array.isArray(values) ? values : [];
}

function formatSummary(summary: GroupChatSummary, tokenBudget = GROUP_CONTEXT_POLICY.SUMMARY_CONTEXT_TOKEN_BUDGET): string {
  const parts: string[] = [];
  if (summary.summary) parts.push(summary.summary);
  if (summary.latestObjective) parts.push(`Current focus: ${summary.latestObjective}`);
  if (summary.latestDirection) parts.push(`Direction: ${summary.latestDirection}`);

  const items: string[] = [];
  for (const d of asSummaryArray(summary.decisions)) items.push(`decided: ${d}`);
  for (const q of asSummaryArray(summary.openQuestions)) items.push(`open question: ${q}`);
  for (const b of asSummaryArray(summary.blockers)) items.push(`blocker: ${b}`);
  for (const dl of asSummaryArray(summary.deadlines)) items.push(`deadline: ${dl}`);
  if (items.length > 0) parts.push(items.join('. '));

  const text = parts.join(' ');
  return truncateToBudget(text, tokenBudget);
}

function formatTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return date.toISOString();
}

function indentBlock(text: string, prefix = '  '): string {
  return text.split('\n').map(line => `${prefix}${line}`).join('\n');
}

function defaultRetrievalHint(att: GroupChatAttachmentContext): string | null {
  if (att.retrievalHint) return att.retrievalHint;
  if (att.fileAssetId) {
    return `For more detail beyond the inline excerpt, use contextSearch or documentRag with fileAssetId="${att.fileAssetId}" or filename "${att.fileName}".`;
  }
  if (att.ingestionStatus === 'processing' || att.ingestionStatus === 'pending' || att.isInlineComplete === false) {
    return `If the inline context is incomplete and more detail is needed after indexing, use contextSearch or documentRag with filename "${att.fileName}".`;
  }
  return null;
}

function formatAttachmentContext(att: GroupChatAttachmentContext): string {
  const meta = [
    att.mimeType,
    att.ingestionStatus ? `status=${att.ingestionStatus}` : '',
    att.fileAssetId ? `fileAssetId=${att.fileAssetId}` : '',
    att.indexedChunkCount !== undefined ? `chunks=${att.indexedChunkCount}` : '',
    att.documentClass ? `class=${att.documentClass}` : '',
  ].filter(Boolean).join('; ');
  const lines = [
    `  [internal attachment context: ${att.kind} "${att.fileName}"${meta ? `; ${meta}` : ''}]`,
    `  Attachment placement: this upload belongs to this exact transcript message; nearby "this ${att.kind}" references usually point here.`,
  ];

  if (att.inlineContext) {
    lines.push(indentBlock(att.inlineContext));
  } else if (att.error) {
    lines.push(`  Extraction/indexing error: ${att.error}`);
  } else if (att.ingestionStatus === 'processing' || att.ingestionStatus === 'pending') {
    lines.push('  Attachment extraction/indexing is still running in the background.');
  }

  const hint = defaultRetrievalHint(att);
  if (hint) lines.push(`  Retrieval hint: ${hint}`);

  return lines.join('\n');
}

export function formatMessage(msg: GroupChatMessage): string {
  const prefix = msg.role === 'assistant' ? '@Divo' : msg.senderName;
  const mention = msg.botMentioned ? ' @Divo' : '';
  let line = `[${formatTimestamp(msg.createdAt)}] ${prefix}${mention}: ${msg.content}`;
  if (msg.attachedFiles && msg.attachedFiles.length > 0) {
    line += ` [files: ${msg.attachedFiles.join(', ')}]`;
  }
  if (msg.attachments && msg.attachments.length > 0) {
    line += `\n${msg.attachments.map(formatAttachmentContext).join('\n')}`;
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

export function formatGroupContextForPrompt(
  window: GroupChatWindow,
  currentMessage?: { senderName: string; content: string },
): string {
  const sections: string[] = [
    'GROUP CHAT CONTEXT — recent conversation in this group chat.',
    'When the user refers to "above", "previous message", or "that", they mean the messages in this transcript.',
    'When the current request says "this image", "this file", "the attached image/file", or similar, resolve it to the nearest preceding message with [internal attachment context] in this transcript.',
    'Inline attachment context is already in hand. Answer from it first; use contextSearch or documentRag only if the transcript lacks the attachment context, it is marked incomplete/pending, or the user asks for more detail than the inline excerpt contains.',
    'Attachment OCR/file excerpts below are internal context attached to the exact message where the upload happened; do not claim they were sent as visible Lark text.',
    'The user\'s current request is the LAST line (marked with ▶).',
  ];

  if (window.summary) {
    const summaryText = formatSummary(window.summary);
    if (summaryText) {
      sections.push('');
      sections.push('── ROLLING SUMMARY (older discussion) ──');
      sections.push(summaryText);
    }
  }

  const transcriptLines = formatTranscriptLines(window.recentMessages);
  if (transcriptLines.length > 0 || currentMessage) {
    sections.push('');
    sections.push('── RECENT MESSAGES ──');
    sections.push(...transcriptLines);
  }

  if (currentMessage) {
    sections.push(`▶ [now] ${currentMessage.senderName} → @Divo: ${currentMessage.content}`);
  }

  return sections.join('\n');
}
