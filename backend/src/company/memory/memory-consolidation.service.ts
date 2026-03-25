import { prisma } from '../../utils/prisma';
import {
  buildBehaviorProfileSummary,
  formatKindLabel,
  type ExtractedMemoryDraft,
  type FlatUserMemoryItem,
} from './contracts';
import { memoryRetentionService } from './memory-retention.service';

const isSameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

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

const buildThreadScopeWhere = (draft: ExtractedMemoryDraft) =>
  draft.scope === 'thread_pinned'
    ? {
      threadId: draft.threadId ?? null,
      conversationKey: draft.conversationKey ?? null,
    }
    : {};

class MemoryConsolidationService {
  async upsertDrafts(input: {
    companyId: string;
    userId: string;
    drafts: ExtractedMemoryDraft[];
  }): Promise<FlatUserMemoryItem[]> {
    const results: FlatUserMemoryItem[] = [];

    for (const draft of input.drafts) {
      if (draft.kind === 'response_style') {
        results.push(await this.upsertResponseStyle(input.companyId, input.userId, draft));
        continue;
      }

      if (draft.kind === 'identity') {
        results.push(await this.upsertSlotLikeMemory(input.companyId, input.userId, draft));
        continue;
      }

      results.push(await this.upsertGeneralMemory(input.companyId, input.userId, draft));
    }

    await memoryRetentionService.applyRetention({
      companyId: input.companyId,
      userId: input.userId,
    });
    await this.syncBehaviorProfile({
      companyId: input.companyId,
      userId: input.userId,
    });

    return results;
  }

  async syncBehaviorProfile(input: { companyId: string; userId: string }): Promise<void> {
    const latestStyle = await prisma.userMemoryItem.findFirst({
      where: {
        companyId: input.companyId,
        userId: input.userId,
        kind: 'response_style',
        status: 'active',
      },
      orderBy: {
        updatedAt: 'desc',
      },
      select: {
        id: true,
        valueJson: true,
      },
    });

    const valueJson = latestStyle?.valueJson && typeof latestStyle.valueJson === 'object' && !Array.isArray(latestStyle.valueJson)
      ? latestStyle.valueJson as Record<string, unknown>
      : {};

    await prisma.userMemoryProfile.upsert({
      where: {
        companyId_userId: {
          companyId: input.companyId,
          userId: input.userId,
        },
      },
      update: {
        preferredReplyLength: typeof valueJson.preferredReplyLength === 'string'
          ? valueJson.preferredReplyLength
          : null,
        preferredTone: typeof valueJson.preferredTone === 'string'
          ? valueJson.preferredTone
          : null,
        preferredFormatting: typeof valueJson.preferredFormatting === 'string'
          ? valueJson.preferredFormatting
          : null,
        updatedFromMemoryItemId: latestStyle?.id ?? null,
      },
      create: {
        companyId: input.companyId,
        userId: input.userId,
        preferredReplyLength: typeof valueJson.preferredReplyLength === 'string'
          ? valueJson.preferredReplyLength
          : null,
        preferredTone: typeof valueJson.preferredTone === 'string'
          ? valueJson.preferredTone
          : null,
        preferredFormatting: typeof valueJson.preferredFormatting === 'string'
          ? valueJson.preferredFormatting
          : null,
        updatedFromMemoryItemId: latestStyle?.id ?? null,
      },
    });
  }

  private async upsertResponseStyle(
    companyId: string,
    userId: string,
    draft: ExtractedMemoryDraft,
  ): Promise<FlatUserMemoryItem> {
    const profile = await prisma.userMemoryProfile.findUnique({
      where: {
        companyId_userId: {
          companyId,
          userId,
        },
      },
    });

    const mergedValue = {
      preferredReplyLength:
        typeof draft.valueJson.preferredReplyLength === 'string'
          ? draft.valueJson.preferredReplyLength
          : profile?.preferredReplyLength ?? undefined,
      preferredTone:
        typeof draft.valueJson.preferredTone === 'string'
          ? draft.valueJson.preferredTone
          : profile?.preferredTone ?? undefined,
      preferredFormatting:
        typeof draft.valueJson.preferredFormatting === 'string'
          ? draft.valueJson.preferredFormatting
          : profile?.preferredFormatting ?? undefined,
    };

    const summary = buildBehaviorProfileSummary(mergedValue) ?? 'User response style preferences.';
    const existing = await prisma.userMemoryItem.findMany({
      where: {
        companyId,
        userId,
        kind: 'response_style',
        status: 'active',
      },
      select: {
        id: true,
      },
    });

    if (existing.length > 0) {
      await prisma.userMemoryItem.updateMany({
        where: {
          id: { in: existing.map((item) => item.id) },
        },
        data: {
          status: 'superseded',
        },
      });
    }

    const created = await prisma.userMemoryItem.create({
      data: {
        companyId,
        userId,
        kind: 'response_style',
        scope: draft.scope,
        channelOrigin: draft.channelOrigin,
        threadId: draft.threadId,
        conversationKey: draft.conversationKey,
        subjectKey: 'response_style',
        summary,
        valueJson: mergedValue,
        confidence: Math.max(0.75, draft.confidence),
        source: draft.source,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        lastConfirmedAt: draft.lastConfirmedAt ?? null,
        staleAfterAt: null,
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
    });

    return mapMemoryItem(created);
  }

  private async upsertSlotLikeMemory(
    companyId: string,
    userId: string,
    draft: ExtractedMemoryDraft,
  ): Promise<FlatUserMemoryItem> {
    const existing = await prisma.userMemoryItem.findFirst({
      where: {
        companyId,
        userId,
        kind: draft.kind,
        subjectKey: draft.subjectKey,
        status: 'active',
        ...buildThreadScopeWhere(draft),
      },
      orderBy: {
        updatedAt: 'desc',
      },
      select: {
        id: true,
        summary: true,
        valueJson: true,
      },
    });

    if (existing && existing.summary === draft.summary && isSameJson(existing.valueJson, draft.valueJson)) {
      const updated = await prisma.userMemoryItem.update({
        where: { id: existing.id },
        data: {
          confidence: Math.min(1, draft.confidence),
          lastSeenAt: new Date(),
          lastConfirmedAt: draft.lastConfirmedAt ?? new Date(),
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
      });
      return mapMemoryItem(updated);
    }

    if (existing) {
      await prisma.userMemoryItem.update({
        where: { id: existing.id },
        data: {
          status: 'superseded',
        },
      });
    }

    const created = await prisma.userMemoryItem.create({
      data: {
        companyId,
        userId,
        kind: draft.kind,
        scope: draft.scope,
        channelOrigin: draft.channelOrigin,
        threadId: draft.threadId,
        conversationKey: draft.conversationKey,
        subjectKey: draft.subjectKey,
        summary: draft.summary,
        valueJson: draft.valueJson,
        confidence: draft.confidence,
        status: 'active',
        source: draft.source,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        lastConfirmedAt: draft.lastConfirmedAt ?? null,
        staleAfterAt: draft.staleAfterAt ?? null,
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
    });

    return mapMemoryItem(created);
  }

  private async upsertGeneralMemory(
    companyId: string,
    userId: string,
    draft: ExtractedMemoryDraft,
  ): Promise<FlatUserMemoryItem> {
    const existing = await prisma.userMemoryItem.findFirst({
      where: {
        companyId,
        userId,
        kind: draft.kind,
        subjectKey: draft.subjectKey,
        status: 'active',
        ...buildThreadScopeWhere(draft),
      },
      orderBy: {
        updatedAt: 'desc',
      },
      select: {
        id: true,
        confidence: true,
        summary: true,
        valueJson: true,
      },
    });

    if (existing) {
      const updated = await prisma.userMemoryItem.update({
        where: {
          id: existing.id,
        },
        data: {
          summary: draft.summary,
          valueJson: draft.valueJson,
          confidence: isSameJson(existing.valueJson, draft.valueJson) && existing.summary === draft.summary
            ? Math.min(1, Math.max(existing.confidence, draft.confidence) + 0.05)
            : draft.confidence,
          channelOrigin: draft.channelOrigin,
          source: draft.source,
          lastSeenAt: new Date(),
          lastConfirmedAt: draft.lastConfirmedAt ?? undefined,
          staleAfterAt: draft.staleAfterAt ?? undefined,
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
      });
      return mapMemoryItem(updated);
    }

    const created = await prisma.userMemoryItem.create({
      data: {
        companyId,
        userId,
        kind: draft.kind,
        scope: draft.scope,
        channelOrigin: draft.channelOrigin,
        threadId: draft.threadId,
        conversationKey: draft.conversationKey,
        subjectKey: draft.subjectKey,
        summary: draft.summary,
        valueJson: draft.valueJson,
        confidence: draft.confidence,
        status: 'active',
        source: draft.source,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        lastConfirmedAt: draft.lastConfirmedAt ?? null,
        staleAfterAt: draft.staleAfterAt ?? null,
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
    });

    return mapMemoryItem(created);
  }
}

export const memoryConsolidationService = new MemoryConsolidationService();
