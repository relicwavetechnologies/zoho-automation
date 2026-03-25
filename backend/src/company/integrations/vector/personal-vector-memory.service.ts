import { createHash } from 'crypto';

import config from '../../../config';
import { embeddingService } from '../embedding';
import { logger } from '../../../utils/logger';
import { googleRankingService } from '../search/google-ranking.service';
import { qdrantAdapter } from './qdrant.adapter';
import { vectorDocumentRepository } from './vector-document.repository';
import { buildCanonicalChatChunks } from './canonical-retrieval';
import { RETRIEVAL_PROFILE_CONFIG } from './retrieval-contract';

const hashContent = (content: string): string => createHash('sha256').update(content).digest('hex');

export type PersonalMemoryMatch = {
  sourceId: string;
  score: number;
  content: string;
  role?: string;
  conversationKey?: string;
  documentKey?: string;
};

const PERSONAL_VECTOR_QUERY_CACHE_TTL_MS = 20_000;

type PersonalMemoryQueryCacheEntry = {
  expiresAt: number;
  promise: Promise<PersonalMemoryMatch[]>;
};

class PersonalVectorMemoryService {
  private readonly queryCache = new Map<string, PersonalMemoryQueryCacheEntry>();

  private buildQueryCacheKey(input: {
    companyId: string;
    requesterUserId: string;
    text: string;
    conversationKey?: string;
  }): string {
    return [
      input.companyId,
      input.requesterUserId,
      input.conversationKey ?? '',
      hashContent(input.text.trim().toLowerCase()),
    ].join(':');
  }

  private pruneExpiredQueryCache(nowMs = Date.now()): void {
    for (const [key, entry] of this.queryCache.entries()) {
      if (entry.expiresAt <= nowMs) {
        this.queryCache.delete(key);
      }
    }
  }

  async query(input: {
    companyId: string;
    requesterUserId: string;
    text: string;
    limit?: number;
    conversationKey?: string;
  }): Promise<PersonalMemoryMatch[]> {
    const normalized = input.text.trim();
    if (!normalized) {
      return [];
    }

    this.pruneExpiredQueryCache();
    const profile = RETRIEVAL_PROFILE_CONFIG.chat;
    const effectiveLimit = Math.max(profile.finalTopK, input.limit ?? profile.finalTopK);
    const cacheKey = this.buildQueryCacheKey({
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      conversationKey: input.conversationKey,
      text: normalized,
    });
    const cached = this.queryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return (await cached.promise).slice(0, input.limit ?? profile.finalTopK);
    }

    const queryPromise = (async () => {
      logger.info('personal.vector.query.start', {
        companyId: input.companyId,
        requesterUserId: input.requesterUserId,
        conversationKey: input.conversationKey,
        queryLength: normalized.length,
        limit: input.limit,
        effectiveLimit,
      }, { sampleRate: 0.1 });

      const [queryVector] = await embeddingService.embedQueries([normalized]);
      const groups = await qdrantAdapter.search({
        companyId: input.companyId,
        requesterUserId: input.requesterUserId,
        conversationKey: input.conversationKey,
        denseVector: queryVector,
        limit: Math.max(1, Math.min(profile.groupLimit, effectiveLimit)),
        candidateLimit: profile.branchLimit,
        retrievalProfile: 'chat',
        lexicalQueryText: normalized,
        fusion: 'dbsf',
        groupByField: 'documentKey',
        groupSize: profile.groupSize,
        sourceTypes: ['chat_turn'],
        includePersonal: true,
        includeShared: false,
        includePublic: false,
      });
      const matches = groups.flatMap((group) => group.hits);
      const reranked = await googleRankingService.rerank(
        normalized,
        matches.map((match) => ({
          id: `${match.sourceType}:${match.sourceId}:${match.chunkIndex}`,
          documentKey: match.documentKey ?? `${input.companyId}:chat_turn:${match.sourceId}`,
          chunkIndex: match.chunkIndex,
          title: typeof match.payload.title === 'string' ? match.payload.title : undefined,
          content:
            typeof match.payload._chunk === 'string'
              ? match.payload._chunk
              : typeof match.payload.text === 'string'
                ? match.payload.text
                : '',
          score: match.score,
          payload: match.payload,
        })),
        profile.finalTopK,
        { required: config.NODE_ENV === 'production' && !config.RAG_CHAT_RERANK_OPTIONAL },
      );
      const rerankedById = new Map(reranked.map((item) => [item.id, item]));

      const finalMatches = matches
        .filter((match) =>
          rerankedById.has(`${match.sourceType}:${match.sourceId}:${match.chunkIndex}`),
        )
        .sort((left, right) => {
          const leftScore =
            rerankedById.get(`${left.sourceType}:${left.sourceId}:${left.chunkIndex}`)?.rerankScore ??
            left.score;
          const rightScore =
            rerankedById.get(`${right.sourceType}:${right.sourceId}:${right.chunkIndex}`)
              ?.rerankScore ?? right.score;
          return rightScore - leftScore;
        })
        .map((match) => ({
          sourceId: match.sourceId,
          score: match.score,
          documentKey: match.documentKey,
          content:
            typeof match.payload._chunk === 'string'
              ? match.payload._chunk
              : typeof match.payload.text === 'string'
                ? match.payload.text
                : '',
          role: typeof match.payload.role === 'string' ? match.payload.role : undefined,
          conversationKey:
            typeof match.payload.conversationKey === 'string'
              ? match.payload.conversationKey
              : undefined,
        }))
        .filter((match) => match.content.length > 0);

      logger.info('personal.vector.query.completed', {
        companyId: input.companyId,
        requesterUserId: input.requesterUserId,
        conversationKey: input.conversationKey,
        candidateCount: matches.length,
        resultCount: finalMatches.length,
        topScores: finalMatches.slice(0, 3).map((match) => Number(match.score.toFixed(4))),
      }, { sampleRate: 0.1 });

      return finalMatches;
    })();

    this.queryCache.set(cacheKey, {
      expiresAt: Date.now() + PERSONAL_VECTOR_QUERY_CACHE_TTL_MS,
      promise: queryPromise,
    });

    try {
      return (await queryPromise).slice(0, input.limit ?? profile.finalTopK);
    } catch (error) {
      this.queryCache.delete(cacheKey);
      throw error;
    }
  }

  async storeChatTurn(input: {
    companyId: string;
    requesterUserId: string;
    conversationKey: string;
    sourceId: string;
    role: 'user' | 'assistant';
    text: string;
    channel: string;
    chatId: string;
  }): Promise<void> {
    logger.info('personal.vector.turn.store.start', {
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      conversationKey: input.conversationKey,
      sourceId: input.sourceId,
      role: input.role,
      textLength: input.text.trim().length,
    }, { sampleRate: 0.05 });

    const chunks = buildCanonicalChatChunks({
      companyId: input.companyId,
      sourceId: input.sourceId,
      requesterUserId: input.requesterUserId,
      conversationKey: input.conversationKey,
      role: input.role,
      channel: input.channel,
      chatId: input.chatId,
      text: input.text,
      visibility: 'personal',
    });
    if (chunks.length === 0) {
      logger.info('personal.vector.turn.store.skipped', {
        companyId: input.companyId,
        requesterUserId: input.requesterUserId,
        conversationKey: input.conversationKey,
        sourceId: input.sourceId,
        reason: 'no_chunks',
      }, { sampleRate: 0.05 });
      return;
    }

    const embeddings = await embeddingService.embedDocuments(
      chunks.map((chunk) => ({
        title: chunk.title,
        text: chunk.chunkText,
      })),
    );
    const records = chunks.map((chunk, index) => ({
      companyId: input.companyId,
      sourceType: 'chat_turn' as const,
      sourceId: input.sourceId,
      chunkIndex: chunk.chunkIndex,
      documentKey: chunk.documentKey,
      chunkText: chunk.chunkText,
      contentHash: hashContent(chunk.chunkText),
      visibility: chunk.visibility,
      ownerUserId: input.requesterUserId,
      conversationKey: input.conversationKey,
      payload: {
        ...chunk.payload,
        _chunk: chunk.chunkText,
      },
      embedding: embeddings[index],
      denseEmbedding: embeddings[index],
      updatedAt: chunk.sourceUpdatedAt,
      embeddingSchemaVersion: chunk.embeddingSchemaVersion,
      retrievalProfile: chunk.retrievalProfile,
      sourceUpdatedAt: chunk.sourceUpdatedAt,
      title: chunk.title,
      content: chunk.chunkText,
    }));

    await vectorDocumentRepository.upsertMany(records);
    await qdrantAdapter.upsertVectors(records);

    logger.info('personal.vector.turn.stored', {
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      conversationKey: input.conversationKey,
      sourceId: input.sourceId,
      role: input.role,
      chunkCount: records.length,
      profileChunkCount: records.filter((record) => (record.payload as Record<string, unknown>)?.memoryKind === 'user_profile_fact').length,
      memoryKinds: Array.from(new Set(records.map((record) => {
        const payload = record.payload as Record<string, unknown>;
        return typeof payload.memoryKind === 'string' ? payload.memoryKind : 'chat_turn';
      }))),
    }, { sampleRate: 0.1 });
  }

  /**
   * Promotes all personal chat-turn vectors for a given conversation from
   * `personal` visibility to `shared` (company-wide) visibility.
   *
   * This is a two-phase write:
   * 1. PostgreSQL is updated first (source of truth for metadata).
   * 2. Qdrant vectors are re-upserted with the new visibility flag so queries
   *    from other users immediately start seeing this content.
   */
  async shareConversation(input: {
    companyId: string;
    requesterUserId: string;
    conversationKey: string;
    sharedThroughAt?: Date;
  }): Promise<{ sharedCount: number }> {
    // Phase 1: Fetch docs FIRST while they are still `personal` (findByConversation
    // filters on visibility='personal' so we get them before the flag changes).
    const docsToShare = await vectorDocumentRepository.findByConversation({
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      conversationKey: input.conversationKey,
      createdAtLte: input.sharedThroughAt,
    });

    if (docsToShare.length === 0) {
      logger.warn('personal.vector.conversation.share.no_docs', {
        companyId: input.companyId,
        conversationKey: input.conversationKey,
      });
      return { sharedCount: 0 };
    }

    // Phase 2: Update visibility in PostgreSQL (the authoritative metadata store)
    await vectorDocumentRepository.reassignConversationVisibility({
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      conversationKey: input.conversationKey,
      visibility: 'shared',
      createdAtLte: input.sharedThroughAt,
    });

    // Phase 3: Sync the updated visibility flag to Qdrant
    await qdrantAdapter.upsertVectors(
      docsToShare.map((doc) => {
        const payload = (doc.payload ?? {}) as Record<string, unknown>;
        const content =
          typeof payload._chunk === 'string'
            ? payload._chunk
            : typeof payload.text === 'string'
              ? payload.text
              : '';
        const title = typeof payload.title === 'string' ? payload.title : 'chat turn';
        return {
          companyId: doc.companyId,
          sourceType: doc.sourceType as 'chat_turn',
          sourceId: doc.sourceId,
          chunkIndex: doc.chunkIndex,
          contentHash: doc.contentHash,
          visibility: 'shared' as const,
          ownerUserId: doc.ownerUserId ?? undefined,
          conversationKey: doc.conversationKey ?? undefined,
          documentKey: doc.documentKey ?? `${doc.companyId}:chat_turn:${doc.sourceId}`,
          chunkText: content,
          payload,
          denseEmbedding: doc.embedding as number[],
          retrievalProfile: (payload.retrievalProfile as 'chat' | undefined) ?? 'chat',
          embeddingSchemaVersion:
            typeof payload.embeddingSchemaVersion === 'string'
              ? payload.embeddingSchemaVersion
              : undefined,
          updatedAt:
            typeof payload.sourceUpdatedAt === 'string'
              ? payload.sourceUpdatedAt
              : typeof payload.updatedAt === 'string'
                ? payload.updatedAt
                : undefined,
          sourceUpdatedAt:
            typeof payload.sourceUpdatedAt === 'string' ? payload.sourceUpdatedAt : undefined,
          title,
          content,
        };
      }),
    );

    logger.info('personal.vector.conversation.shared', {
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      conversationKey: input.conversationKey,
      sharedCount: docsToShare.length,
      sharedThroughAt: input.sharedThroughAt?.toISOString(),
    });

    return { sharedCount: docsToShare.length };
  }

  /**
   * Returns a short human-readable preview of the conversation vectors
   * for display in admin approval cards. Shows up to 5 text snippets.
   */
  async getConversationPreview(
    companyId: string,
    requesterUserId: string,
    conversationKey: string,
  ): Promise<string | null> {
    const docs = await vectorDocumentRepository.findByConversation({
      companyId,
      requesterUserId,
      conversationKey,
    });
    if (docs.length === 0) return null;

    const lines = docs
      .slice(0, 5)
      .map((doc) => {
        const payload = (doc.payload ?? {}) as Record<string, unknown>;
        const text = typeof payload.text === 'string' ? payload.text.slice(0, 200) : null;
        const role = typeof payload.role === 'string' ? payload.role : 'message';
        return text ? `- [${role}]: ${text}` : null;
      })
      .filter((line): line is string => line !== null);

    return lines.length > 0 ? lines.join('\n') : null;
  }
}

export const personalVectorMemoryService = new PersonalVectorMemoryService();
