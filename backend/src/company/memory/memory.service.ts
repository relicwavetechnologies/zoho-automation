import { logger } from '../../utils/logger';
import { prisma } from '../../utils/prisma';
import { memoryConsolidationService } from './memory-consolidation.service';
import { memoryContextService } from './memory-context.service';
import {
  formatKindLabel,
  type DurableMemoryContextClass,
  type ListedUserMemory,
  type MemoryPromptContext,
  type UserMemoryChannelOrigin,
} from './contracts';
import { memoryExtractionService } from './memory-extraction.service';
import { toolRoutingService, type ToolRoutingExecutionOutcome, type ToolRoutingPriorMatch } from './tool-routing.service';

class MemoryService {
  async recordUserTurnOrThrow(input: {
    companyId: string;
    userId?: string | null;
    channelOrigin: UserMemoryChannelOrigin;
    threadId?: string;
    conversationKey?: string;
    localTimeZoneHint?: string;
    text: string;
  }): Promise<{ draftCount: number; wasExplicitInstruction: boolean }> {
    if (!input.userId || !input.text.trim()) {
      return {
        draftCount: 0,
        wasExplicitInstruction: false,
      };
    }
    const extraction = memoryExtractionService.analyzeUserMessage({
      channelOrigin: input.channelOrigin,
      threadId: input.threadId,
      conversationKey: input.conversationKey,
      localTimeZoneHint: input.localTimeZoneHint,
      text: input.text,
    });
    if (extraction.drafts.length === 0) {
      return {
        draftCount: 0,
        wasExplicitInstruction: extraction.wasExplicitInstruction,
      };
    }
    await memoryConsolidationService.upsertDrafts({
      companyId: input.companyId,
      userId: input.userId,
      drafts: extraction.drafts,
    });
    await memoryContextService.invalidateCache({
      companyId: input.companyId,
      userId: input.userId,
      threadId: input.threadId,
      conversationKey: input.conversationKey,
    });
    return {
      draftCount: extraction.drafts.length,
      wasExplicitInstruction: extraction.wasExplicitInstruction,
    };
  }

  async recordUserTurn(input: {
    companyId: string;
    userId?: string | null;
    channelOrigin: UserMemoryChannelOrigin;
    threadId?: string;
    conversationKey?: string;
    localTimeZoneHint?: string;
    text: string;
  }): Promise<void> {
    try {
      await this.recordUserTurnOrThrow(input);
    } catch (error) {
      logger.warn('memory.user_turn.record.failed', {
        companyId: input.companyId,
        userId: input.userId,
        channelOrigin: input.channelOrigin,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  async recordTaskStateSnapshot(input: {
    companyId: string;
    userId?: string | null;
    channelOrigin: UserMemoryChannelOrigin;
    threadId?: string;
    conversationKey?: string;
    activeObjective?: string | null;
    completedMutations?: Array<{ module?: string; summary: string; ok: boolean }>;
  }): Promise<void> {
    if (!input.userId) {
      return;
    }
    try {
      const drafts = memoryExtractionService.extractFromTaskStateSnapshot({
        channelOrigin: input.channelOrigin,
        threadId: input.threadId,
        conversationKey: input.conversationKey,
        activeObjective: input.activeObjective,
        completedMutations: input.completedMutations,
      });
      if (drafts.length === 0) {
        return;
      }
      await memoryConsolidationService.upsertDrafts({
        companyId: input.companyId,
        userId: input.userId,
        drafts,
      });
      await memoryContextService.invalidateCache({
        companyId: input.companyId,
        userId: input.userId,
        threadId: input.threadId,
        conversationKey: input.conversationKey,
      });
    } catch (error) {
      logger.warn('memory.task_state.record.failed', {
        companyId: input.companyId,
        userId: input.userId,
        channelOrigin: input.channelOrigin,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  async getPromptContext(input: {
    companyId: string;
    userId?: string | null;
    threadId?: string;
    conversationKey?: string;
    queryText: string;
    contextClass: DurableMemoryContextClass;
  }): Promise<MemoryPromptContext> {
    return memoryContextService.buildPromptContext(input);
  }

  async findRoutingPriors(input: {
    companyId: string;
    userId?: string | null;
    threadId?: string;
    conversationKey?: string;
    allowedToolIds?: string[];
    latestUserMessage: string;
    childRoute?: {
      normalizedIntent?: string | null;
      reason?: string | null;
      suggestedToolIds?: string[];
      suggestedActions?: string[];
    };
    hasWorkspace?: boolean;
    hasArtifacts?: boolean;
  }): Promise<{
    intent: Awaited<ReturnType<typeof toolRoutingService.findRoutingPriors>>['intent'] | null;
    priors: ToolRoutingPriorMatch[];
  }> {
    if (!input.userId) {
      return {
        intent: null,
        priors: [],
      };
    }
    return toolRoutingService.findRoutingPriors({
      companyId: input.companyId,
      userId: input.userId,
      threadId: input.threadId,
      conversationKey: input.conversationKey,
      allowedToolIds: input.allowedToolIds,
      latestUserMessage: input.latestUserMessage,
      childRoute: input.childRoute,
      hasWorkspace: input.hasWorkspace,
      hasArtifacts: input.hasArtifacts,
    });
  }

  async recordToolSelectionOutcome(input: {
    companyId: string;
    userId?: string | null;
    channelOrigin: UserMemoryChannelOrigin;
    threadId?: string;
    conversationKey?: string;
    latestUserMessage: string;
    childRoute?: {
      normalizedIntent?: string | null;
      reason?: string | null;
      suggestedToolIds?: string[];
      suggestedActions?: string[];
    };
    hasWorkspace?: boolean;
    hasArtifacts?: boolean;
    plannerChosenToolId?: string;
    plannerChosenOperationClass?: string;
    runExposedToolIds?: string[];
    selectionReason?: string;
    toolResults: ToolRoutingExecutionOutcome[];
  }): Promise<void> {
    if (!input.userId) {
      return;
    }
    try {
      await toolRoutingService.recordToolSelectionOutcome(input);
    } catch (error) {
      logger.warn('memory.tool_routing.record.failed', {
        companyId: input.companyId,
        userId: input.userId,
        channelOrigin: input.channelOrigin,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  async invalidateCache(input: {
    companyId: string;
    userId: string;
    threadId?: string;
    conversationKey?: string;
  }): Promise<void> {
    await memoryContextService.invalidateCache(input);
  }

  async listForUser(input: { companyId: string; userId: string }): Promise<{
    profile: Awaited<ReturnType<typeof prisma.userMemoryProfile.findUnique>>;
    items: ListedUserMemory[];
    grouped: Record<string, ListedUserMemory[]>;
  }> {
    const [profile, rows] = await Promise.all([
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
        },
        orderBy: [
          { updatedAt: 'desc' },
          { confidence: 'desc' },
        ],
      }),
    ]);

    const items = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      scope: row.scope,
      subjectKey: row.subjectKey,
      summary: row.summary,
      valueJson: row.valueJson && typeof row.valueJson === 'object' && !Array.isArray(row.valueJson)
        ? row.valueJson as Record<string, unknown>
        : {},
      confidence: row.confidence,
      status: row.status,
      source: row.source,
      threadId: row.threadId,
      conversationKey: row.conversationKey,
      lastSeenAt: row.lastSeenAt,
      lastConfirmedAt: row.lastConfirmedAt,
      staleAfterAt: row.staleAfterAt,
      updatedAt: row.updatedAt,
      kindLabel: formatKindLabel(row.kind),
    }));

    const grouped = items.reduce<Record<string, ListedUserMemory[]>>((acc, item) => {
      if (!acc[item.kind]) {
        acc[item.kind] = [];
      }
      acc[item.kind]!.push(item);
      return acc;
    }, {});

    return {
      profile,
      items,
      grouped,
    };
  }

  async forgetMemory(input: { companyId: string; userId: string; memoryId: string }): Promise<boolean> {
    const existing = await prisma.userMemoryItem.findFirst({
      where: {
        id: input.memoryId,
        companyId: input.companyId,
        userId: input.userId,
      },
      select: {
        id: true,
      },
    });
    if (!existing) {
      return false;
    }

    await prisma.userMemoryItem.update({
      where: {
        id: existing.id,
      },
      data: {
        status: 'forgotten',
      },
    });
    await memoryConsolidationService.syncBehaviorProfile({
      companyId: input.companyId,
      userId: input.userId,
    });
    await memoryContextService.invalidateCache({
      companyId: input.companyId,
      userId: input.userId,
    });
    return true;
  }

  async clearUserMemory(input: { companyId: string; userId: string }): Promise<void> {
    await prisma.userMemoryItem.updateMany({
      where: {
        companyId: input.companyId,
        userId: input.userId,
        status: 'active',
      },
      data: {
        status: 'forgotten',
      },
    });
    await prisma.userMemoryProfile.upsert({
      where: {
        companyId_userId: {
          companyId: input.companyId,
          userId: input.userId,
        },
      },
      update: {
        preferredReplyLength: null,
        preferredTone: null,
        preferredFormatting: null,
        updatedFromMemoryItemId: null,
      },
      create: {
        companyId: input.companyId,
        userId: input.userId,
      },
    });
    await memoryContextService.invalidateCache({
      companyId: input.companyId,
      userId: input.userId,
    });
  }
}

export const memoryService = new MemoryService();
