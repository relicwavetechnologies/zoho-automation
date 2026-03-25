import { personalVectorMemoryService, type PersonalMemoryMatch } from '../integrations/vector';
import { prisma } from '../../utils/prisma';
import {
  buildBehaviorProfileSummary,
  formatKindLabel,
  type DurableMemoryContextClass,
  type FlatUserMemoryItem,
  type MemoryPromptContext,
  type UserBehaviorProfile,
} from './contracts';
import { memoryRankingService } from './memory-ranking.service';

const isPersonalMemoryQuestion = (value: string | null | undefined): boolean =>
  /\b(do you know|do you remember|remember|recall|what(?:'s| is) my|my (?:fav|favorite|favourite|preferred)|favorite|favourite|preferred|preference|about me|my name|my email)\b/i.test(value ?? '');

const isReferentialFollowup = (value: string | null | undefined): boolean =>
  /\b(next task|pick the next|move on|move to next|continue|next one|same file|same one|next estimate|what next)\b/i.test(value ?? '');

const expandConversationMemoryQuery = (value: string): string => {
  const normalized = value
    .replace(/\bfav\b/gi, 'favorite')
    .replace(/\blang\b/gi, 'language')
    .replace(/\bpref\b/gi, 'preference');
  return normalized === value ? value : `${value}\n${normalized}`;
};

const summarizeText = (value: string | null | undefined, limit = 280): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
};

const summarizeConversationMatches = (
  matches: PersonalMemoryMatch[],
  maxCount: number,
): string[] =>
  matches
    .slice(0, maxCount)
    .map((match) => summarizeText(match.content, 320))
    .filter((entry): entry is string => Boolean(entry));

const dedupeStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
};

const mapMemoryItem = (item: {
  id: string;
  kind: string;
  scope: string;
  subjectKey: string;
  summary: string;
  valueJson: unknown;
  confidence: number;
  status: string;
  source: string;
  threadId: string | null;
  conversationKey: string | null;
  lastSeenAt: Date;
  lastConfirmedAt: Date | null;
  staleAfterAt: Date | null;
  updatedAt: Date;
}): FlatUserMemoryItem => ({
  id: item.id,
  kind: item.kind as FlatUserMemoryItem['kind'],
  scope: item.scope as FlatUserMemoryItem['scope'],
  subjectKey: item.subjectKey,
  summary: item.summary,
  valueJson: item.valueJson && typeof item.valueJson === 'object' && !Array.isArray(item.valueJson)
    ? item.valueJson as Record<string, unknown>
    : {},
  confidence: item.confidence,
  status: item.status as FlatUserMemoryItem['status'],
  source: item.source as FlatUserMemoryItem['source'],
  threadId: item.threadId,
  conversationKey: item.conversationKey,
  lastSeenAt: item.lastSeenAt,
  lastConfirmedAt: item.lastConfirmedAt,
  staleAfterAt: item.staleAfterAt,
  updatedAt: item.updatedAt,
});

class MemoryContextService {
  async buildPromptContext(input: {
    companyId: string;
    userId?: string | null;
    threadId?: string;
    conversationKey?: string;
    queryText: string;
    contextClass: DurableMemoryContextClass;
  }): Promise<MemoryPromptContext> {
    if (!input.userId) {
      return {
        behaviorProfile: null,
        behaviorProfileContext: null,
        durableTaskContext: [],
        durableTaskContextText: null,
        relevantMemoryFacts: [],
        relevantMemoryFactsText: null,
      };
    }

    const [profileRow, activeRows] = await Promise.all([
      prisma.userMemoryProfile.findUnique({
        where: {
          companyId_userId: {
            companyId: input.companyId,
            userId: input.userId,
          },
        },
      }),
      prisma.userMemoryItem.findMany({
        where: {
          companyId: input.companyId,
          userId: input.userId,
          status: 'active',
          OR: [
            { scope: 'user_global' },
            {
              scope: 'thread_pinned',
              threadId: input.threadId ?? null,
            },
            {
              scope: 'thread_pinned',
              conversationKey: input.conversationKey ?? null,
            },
          ],
        },
        orderBy: {
          updatedAt: 'desc',
        },
        select: {
          id: true,
          kind: true,
          scope: true,
          subjectKey: true,
          summary: true,
          valueJson: true,
          confidence: true,
          status: true,
          source: true,
          threadId: true,
          conversationKey: true,
          lastSeenAt: true,
          lastConfirmedAt: true,
          staleAfterAt: true,
          updatedAt: true,
        },
      }),
    ]);

    const behaviorProfile: UserBehaviorProfile | null = profileRow
      ? {
        preferredReplyLength: profileRow.preferredReplyLength ?? undefined,
        preferredTone: profileRow.preferredTone ?? undefined,
        preferredFormatting: profileRow.preferredFormatting ?? undefined,
        updatedFromMemoryItemId: profileRow.updatedFromMemoryItemId ?? null,
      }
      : null;

    const activeItems = activeRows.map(mapMemoryItem);
    const durableTaskItems = activeItems.filter((item) =>
      item.kind === 'ongoing_task'
      || item.kind === 'project'
      || item.kind === 'decision'
      || item.kind === 'constraint');

    const relevantStructured = memoryRankingService.rankRelevant({
      mode: 'off',
      queryText: input.queryText,
      items: activeItems.filter((item) => item.kind !== 'response_style'),
      limit: 6,
    }).map((item) => `${formatKindLabel(item.kind)}: ${item.summary}`);

    const vectorSnippets = await this.retrieveVectorMemory({
      companyId: input.companyId,
      userId: input.userId,
      conversationKey: input.conversationKey,
      queryText: input.queryText,
      contextClass: input.contextClass,
    });

    const durableTaskContext = dedupeStrings(
      durableTaskItems
        .slice(0, 6)
        .map((item) => `${formatKindLabel(item.kind)}: ${item.summary}`),
    );
    const relevantMemoryFacts = dedupeStrings([
      ...relevantStructured,
      ...vectorSnippets,
    ]).slice(0, 8);

    const behaviorSummary = buildBehaviorProfileSummary(behaviorProfile);

    return {
      behaviorProfile,
      behaviorProfileContext: behaviorSummary
        ? `Resolved user behavior profile: ${behaviorSummary}. This should shape the response from the start unless the latest user message overrides it.`
        : null,
      durableTaskContext,
      durableTaskContextText: durableTaskContext.length > 0 ? durableTaskContext.map((entry) => `- ${entry}`).join('\n') : null,
      relevantMemoryFacts,
      relevantMemoryFactsText: relevantMemoryFacts.length > 0 ? relevantMemoryFacts.map((entry) => `- ${entry}`).join('\n') : null,
    };
  }

  private async retrieveVectorMemory(input: {
    companyId: string;
    userId: string;
    conversationKey?: string;
    queryText: string;
    contextClass: DurableMemoryContextClass;
  }): Promise<string[]> {
    const isMemoryQuestion = isPersonalMemoryQuestion(input.queryText);
    if (
      !input.queryText.trim()
      || (
        input.contextClass === 'lightweight_chat'
        && !isMemoryQuestion
        && !isReferentialFollowup(input.queryText)
      )
    ) {
      return [];
    }

    const limit = isMemoryQuestion ? 4 : 3;
    const scopedMatches = await personalVectorMemoryService.query({
      companyId: input.companyId,
      requesterUserId: input.userId,
      conversationKey: input.conversationKey,
      text: isMemoryQuestion ? expandConversationMemoryQuery(input.queryText) : input.queryText,
      limit,
    });

    if (scopedMatches.length > 0 || !isMemoryQuestion) {
      return dedupeStrings(summarizeConversationMatches(scopedMatches, limit));
    }

    const globalMatches = await personalVectorMemoryService.query({
      companyId: input.companyId,
      requesterUserId: input.userId,
      text: expandConversationMemoryQuery(input.queryText),
      limit,
    });
    return dedupeStrings(summarizeConversationMatches(globalMatches, limit));
  }
}

export const memoryContextService = new MemoryContextService();
