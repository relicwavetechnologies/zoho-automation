import { createHash } from 'crypto';

import { embeddingService } from '../embedding';
import { logger } from '../../../utils/logger';
import { qdrantAdapter } from './qdrant.adapter';
import { vectorDocumentRepository } from './vector-document.repository';

const CHAT_CHUNK_SIZE = 420;

const chunkText = (text: string): string[] => {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  for (let index = 0; index < normalized.length; index += CHAT_CHUNK_SIZE) {
    chunks.push(normalized.slice(index, index + CHAT_CHUNK_SIZE));
  }
  return chunks;
};

const hashContent = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

export type PersonalMemoryMatch = {
  sourceId: string;
  score: number;
  content: string;
  role?: string;
  conversationKey?: string;
};

class PersonalVectorMemoryService {
  async query(input: {
    companyId: string;
    requesterUserId: string;
    text: string;
    limit?: number;
  }): Promise<PersonalMemoryMatch[]> {
    const normalized = input.text.trim();
    if (!normalized) {
      return [];
    }

    const [queryVector] = await embeddingService.embed([normalized]);
    const matches = await qdrantAdapter.search({
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      vector: queryVector,
      limit: Math.max(1, Math.min(6, input.limit ?? 4)),
      sourceTypes: ['chat_turn'],
      includePersonal: true,
      includeShared: false,
      includePublic: false,
    });

    return matches
      .map((match) => ({
        sourceId: match.sourceId,
        score: match.score,
        content:
          typeof match.payload._chunk === 'string'
            ? match.payload._chunk
            : typeof match.payload.text === 'string'
              ? match.payload.text
              : '',
        role: typeof match.payload.role === 'string' ? match.payload.role : undefined,
        conversationKey:
          typeof match.payload.conversationKey === 'string' ? match.payload.conversationKey : undefined,
      }))
      .filter((match) => match.content.length > 0);
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
    const chunks = chunkText(input.text);
    if (chunks.length === 0) {
      return;
    }

    const embeddings = await embeddingService.embed(chunks);
    const records = chunks.map((chunk, index) => ({
      companyId: input.companyId,
      sourceType: 'chat_turn' as const,
      sourceId: input.sourceId,
      chunkIndex: index,
      contentHash: hashContent(chunk),
      visibility: 'personal' as const,
      ownerUserId: input.requesterUserId,
      conversationKey: input.conversationKey,
      payload: {
        role: input.role,
        text: input.text,
        channel: input.channel,
        chatId: input.chatId,
        conversationKey: input.conversationKey,
        _chunk: chunk,
      },
      embedding: embeddings[index],
    }));

    await vectorDocumentRepository.upsertMany(records);
    await qdrantAdapter.upsertVectors(records);

    logger.info('personal.vector.turn.stored', {
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      sourceId: input.sourceId,
      role: input.role,
      chunkCount: records.length,
    });
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
    const qdrantRecords = docsToShare.map((doc) => ({
      companyId: doc.companyId,
      sourceType: doc.sourceType as 'chat_turn',
      sourceId: doc.sourceId,
      chunkIndex: doc.chunkIndex,
      contentHash: doc.contentHash,
      visibility: 'shared' as const,
      ownerUserId: doc.ownerUserId ?? undefined,
      conversationKey: doc.conversationKey ?? undefined,
      payload: (doc.payload ?? {}) as Record<string, unknown>,
      embedding: doc.embedding as number[],
    }));
    await qdrantAdapter.upsertVectors(qdrantRecords);

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
