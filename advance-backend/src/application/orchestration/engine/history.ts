import type { Result } from '../../../shared/result';
import { ok } from '../../../shared/result';
import type { Logger } from '../../../shared/logger';
import type { Turn, ConversationWindow } from '../../../domain/conversation/turn';
import { HISTORY_POLICY, isPoisonedAssistantTurn } from '../../../domain/conversation/history-policy';
import type { PermissionResult } from '../../permissions/permission.types';
import type { ConversationRepoPort } from '../../../infrastructure/persistence/conversation.repository';
import type { ChatId } from '../../../shared/ids';
import { maskToolResults } from './tool-result-mask';
import type { ConversationSummary } from '../../../domain/conversation/conversation-summary';
import { formatConversationSummary } from './conversation-summarizer';
import type { ConversationScope } from '../../../domain/conversation/conversation-scope';
import { isInternalHistoryMarker } from '../../../domain/conversation/internal-history-marker';

export type HistoryCompactionTier = 'full' | 'condensed' | 'minimal';

export interface HistoryServiceDeps {
  conversationRepo: ConversationRepoPort;
  logger: Logger;
}

export class HistoryService {
  constructor(private readonly deps: HistoryServiceDeps) {}

  /**
   * Load conversation history for a chat, applying:
   * 1. Poison filter: drops assistant turns that claim permission denied for tools
   *    now actually allowed (prevents agent confusion from stale failures).
   * 2. Token budget cap and message count cap.
   */
  async loadWindow(
    chatId: ChatId,
    opts: {
      filterPoison: boolean;
      perm?: PermissionResult;
      includeSummary?: boolean;
      scope?: ConversationScope;
    },
  ): Promise<Result<ConversationWindow, never>> {
    let summary: string | undefined;
    let raw: Turn[];

    if (opts.includeSummary) {
      const metaResult = await this.deps.conversationRepo.getConversationMeta(chatId, opts.scope);
      const meta = metaResult.ok ? metaResult.value : null;

      if (meta?.summaryJson && meta.lastSummarizedSequence > 0) {
        const histResult = await this.deps.conversationRepo.getHistoryAfterSequence(
          chatId, meta.lastSummarizedSequence, HISTORY_POLICY.MAX_TURNS * 2, opts.scope,
        );
        raw = histResult.ok ? histResult.value : [];
        summary = formatConversationSummary(meta.summaryJson as ConversationSummary);
        this.deps.logger.info('history.summary_loaded', {
          chatId,
          summarizedUpTo: meta.lastSummarizedSequence,
          recentTurns: raw.length,
          summaryLength: summary.length,
        });
      } else {
        const historyResult = await this.deps.conversationRepo.getHistory(chatId, HISTORY_POLICY.MAX_TURNS * 2, opts.scope);
        raw = historyResult.ok ? historyResult.value : [];
      }
    } else {
      const historyResult = await this.deps.conversationRepo.getHistory(chatId, HISTORY_POLICY.MAX_TURNS * 2, opts.scope);
      raw = historyResult.ok ? historyResult.value : [];
    }

    // Legacy minimal compaction markers are prompt-control metadata, not assistant
    // speech. Drop them even when reading historical rows created by older builds.
    let turns = dropOrphanedLeadingAssistants(
      raw.filter(turn => !isInternalHistoryMarker(turn.content)),
    );

    // Apply poison filter
    if (opts.filterPoison) {
      const allowedToolIds = opts.perm
        ? new Set([...opts.perm.allowedToolIds].map(id => String(id).toLowerCase()))
        : new Set<string>();

      turns = turns.filter(turn => {
        if (turn.role !== 'assistant') return true;
        if (!isPoisonedAssistantTurn(turn.content)) return true;

        // If the turn claims a tool is denied, check if it's now allowed
        // If it IS now allowed, this turn is a stale failure — filter it out
        const toolMentionMatch = turn.content.match(/\b(lark\w+|google\w+|zoho\w+|context\w*|web\w*)\b/i);
        if (toolMentionMatch) {
          const mentionedTool = toolMentionMatch[1]!.toLowerCase();
          const nowAllowed = [...allowedToolIds].some(id => id.toLowerCase().includes(mentionedTool.toLowerCase().slice(0, 6)));
          if (nowAllowed) {
            this.deps.logger.info('history.poison.filtered', {
              chatId,
              turnId: turn.id,
              mentionedTool,
              reason: 'tool_now_allowed',
            });
            return false;
          }
        }
        return true;
      });
    }

    // Cap by count
    turns = turns.slice(-HISTORY_POLICY.MAX_TURNS);

    // Mask verbose tool results in older turns (zero LLM cost).
    turns = maskToolResults(turns, HISTORY_POLICY.TOOL_RESULT_VERBATIM_TURNS);

    // Apply read-time compaction tiers before token budgeting.
    turns = turns.map((turn, index) => {
      const distanceFromEnd = turns.length - 1 - index;
      if (distanceFromEnd < HISTORY_POLICY.FULL_TIER_COUNT) {
        return compactTurn(turn, 'full');
      }
      if (distanceFromEnd < HISTORY_POLICY.FULL_TIER_COUNT + HISTORY_POLICY.CONDENSED_TIER_COUNT) {
        return compactTurn(turn, 'condensed');
      }
      return compactTurn(turn, 'minimal');
    });

    // Rough token estimate (4 chars ≈ 1 token)
    let tokenCount = 0;
    const budgeted: Turn[] = [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]!;
      const tokens = Math.ceil(t.content.length / 4);
      if (tokenCount + tokens > HISTORY_POLICY.MAX_TOKEN_BUDGET) break;
      budgeted.unshift(t);
      tokenCount += tokens;
    }

    return ok({
      turns: budgeted,
      truncated: budgeted.length < raw.length,
      tokenEstimate: tokenCount,
      ...(summary ? { summary } : {}),
    });
  }

  async appendTurn(
    chatId: ChatId,
    turn: Omit<Turn, 'id'>,
    scope?: ConversationScope,
  ): Promise<void> {
    const result = await this.deps.conversationRepo.appendTurn(chatId, turn, scope);
    if (!result.ok) {
      this.deps.logger.warn('history.append_failed', {
        chatId,
        companyId: scope?.companyId,
        channel: scope?.channel,
        error: result.error.message,
      });
    }
  }
}

/**
 * A valid conversational prompt cannot begin with an assistant-only transcript.
 * Older unscoped persistence could split user and assistant turns across rows;
 * ignore the orphaned prefix without mutating historical audit data.
 */
function dropOrphanedLeadingAssistants(turns: readonly Turn[]): Turn[] {
  const firstUserIndex = turns.findIndex(turn => turn.role === 'user');
  if (firstUserIndex < 0) return [];
  if (firstUserIndex === 0) return [...turns];
  return turns.slice(firstUserIndex);
}

export function compactTurn(turn: Turn, tier: HistoryCompactionTier): Turn {
  if (tier === 'full') return turn;

  const content = tier === 'condensed'
    ? compactCondensed(turn)
    : compactMinimal(turn);

  if (content === turn.content) return turn;
  return { ...turn, content };
}

function compactCondensed(turn: Turn): string {
  if (turn.role === 'assistant' && hasActionMarkers(turn.content)) {
    return compactAssistantWithActions(turn.content);
  }
  return truncateText(turn.content, 150);
}

function compactMinimal(turn: Turn): string {
  if (turn.role === 'assistant' && hasActionMarkers(turn.content)) {
    const replyLine = extractFirstReplyLine(turn.content);
    return replyLine ? truncateText(replyLine, 80) : 'Earlier tool-assisted request completed.';
  }
  return truncateText(turn.content, 80);
}

function hasActionMarkers(content: string): boolean {
  return content.includes('[Actions]') || content.includes('[Execution]');
}

function compactAssistantWithActions(content: string): string {
  if (content.includes('[Execution]')) {
    return compactExecutionFormat(content, 'condensed');
  }
  const actions = extractActionLines(content);
  const replyLine = extractFirstReplyLine(content);
  const sections: string[] = [];

  if (actions.length > 0) {
    sections.push(`[Actions]\n${actions.join('\n')}`);
  }
  if (replyLine) {
    sections.push(`[Reply]\n${replyLine}`);
  }

  return sections.length > 0 ? sections.join('\n\n') : truncateText(content, 150);
}

function compactExecutionFormat(content: string, tier: 'condensed' | 'minimal'): string {
  const toolNames = extractExecutionToolNames(content);
  const replyLine = extractFirstReplyLine(content);

  if (tier === 'minimal') {
    return replyLine
      ? truncateText(replyLine, 80)
      : toolNames.length > 0
        ? 'Earlier tool-assisted request completed.'
        : truncateText(content, 80);
  }

  const topLines = extractExecutionTopLines(content);
  const sections: string[] = [];
  if (topLines.length > 0) {
    sections.push(`[Execution]\n${topLines.join('\n')}`);
  }
  if (replyLine) {
    sections.push(`[Reply]\n${replyLine}`);
  }
  return sections.length > 0 ? sections.join('\n\n') : truncateText(content, 150);
}

function extractExecutionTopLines(content: string): string[] {
  const execStart = content.indexOf('[Execution]');
  if (execStart < 0) return [];
  const afterExec = content.slice(execStart + '[Execution]'.length);
  const replyStart = afterExec.indexOf('[Reply]');
  const execText = replyStart >= 0 ? afterExec.slice(0, replyStart) : afterExec;
  return execText
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => /^\d+\.\s/.test(line));
}

function extractExecutionToolNames(content: string): string[] {
  const lines = extractExecutionTopLines(content);
  return lines.map(line => {
    const match = line.match(/^\d+\.\s+(\S+)/);
    return match?.[1] ?? '';
  }).filter(Boolean);
}

function extractActionLines(content: string): string[] {
  const actionsStart = content.indexOf('[Actions]');
  if (actionsStart < 0) return [];
  const afterActions = content.slice(actionsStart + '[Actions]'.length);
  const replyStart = afterActions.indexOf('[Reply]');
  const actionsText = replyStart >= 0 ? afterActions.slice(0, replyStart) : afterActions;
  return actionsText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '));
}

function extractActionToolNames(content: string): string[] {
  if (content.includes('[Execution]')) return extractExecutionToolNames(content);

  const seen = new Set<string>();
  const names: string[] = [];

  for (const line of extractActionLines(content)) {
    const match = line.match(/^-\s*([^:\s]+)\s*:/);
    const toolName = match?.[1];
    if (toolName && !seen.has(toolName)) {
      seen.add(toolName);
      names.push(toolName);
    }
  }

  return names;
}

function extractFirstReplyLine(content: string): string | null {
  const replyStart = content.indexOf('[Reply]');
  if (replyStart < 0) return null;
  const replyText = content.slice(replyStart + '[Reply]'.length);
  const firstLine = replyText
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0);
  return firstLine ?? null;
}

function truncateText(content: string, maxChars: number): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 3) return normalized.slice(0, maxChars);
  return `${normalized.slice(0, maxChars - 3)}...`;
}
