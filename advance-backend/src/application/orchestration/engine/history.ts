import type { Result } from '../../../shared/result';
import { ok } from '../../../shared/result';
import type { Logger } from '../../../shared/logger';
import type { Turn, ConversationWindow } from '../../../domain/conversation/turn';
import { HISTORY_POLICY, isPoisonedAssistantTurn } from '../../../domain/conversation/history-policy';
import type { PermissionResult } from '../../permissions/permission.types';
import type { ConversationRepoPort } from '../../../infrastructure/persistence/conversation.repository';
import type { ChatId } from '../../../shared/ids';

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
    },
  ): Promise<Result<ConversationWindow, never>> {
    const historyResult = await this.deps.conversationRepo.getHistory(chatId, HISTORY_POLICY.MAX_TURNS * 2);
    const raw = historyResult.ok ? historyResult.value : [];

    let turns = raw;

    // Apply poison filter
    if (opts.filterPoison) {
      const allowedToolIds = opts.perm
        ? new Set([...opts.perm.allowedToolIds].map(id => String(id).toLowerCase()))
        : new Set<string>();

      turns = raw.filter(turn => {
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
    });
  }

  async appendTurn(
    chatId: ChatId,
    turn: Omit<Turn, 'id'>,
  ): Promise<void> {
    await this.deps.conversationRepo.appendTurn(chatId, turn);
  }
}
