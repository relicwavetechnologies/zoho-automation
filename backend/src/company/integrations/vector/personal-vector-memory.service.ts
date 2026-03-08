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
}

export const personalVectorMemoryService = new PersonalVectorMemoryService();
