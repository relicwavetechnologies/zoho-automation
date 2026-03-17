import { createHash } from 'crypto';

import { prisma } from '../../utils/prisma';
import config from '../../config';
import { logger } from '../../utils/logger';
import { embeddingService } from '../../company/integrations/embedding';
import { qdrantAdapter } from '../../company/integrations/vector/qdrant.adapter';
import { vectorDocumentRepository } from '../../company/integrations/vector/vector-document.repository';
import { extractTextFromBuffer, normalizeExtractedText } from './document-text-extractor';

const DOC_CHUNK_SIZE = 600;
const EMBEDDING_SCHEMA_VERSION = 'gemini-v1';

const chunkText = (text: string, chunkSize = DOC_CHUNK_SIZE): string[] => {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return [];

  const chunks: string[] = [];
  const overlap = Math.floor(chunkSize * 0.1);
  let pos = 0;

  while (pos < normalized.length) {
    chunks.push(normalized.slice(pos, pos + chunkSize));
    pos += chunkSize - overlap;
  }
  return chunks;
};

const hashContent = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

const buildBasePayload = (input: IngestionInput) => ({
  citationType: 'file',
  citationTitle: input.fileName,
  sourceUrl: input.sourceUrl,
  fileName: input.fileName,
  mimeType: input.mimeType,
  cloudinaryUrl: input.sourceUrl,
  fileAssetId: input.fileAssetId,
  allowedRoles: input.allowedRoles,
  embeddingProvider: embeddingService.providerName,
  embeddingModel: embeddingService.providerName === 'gemini'
    ? config.GEMINI_EMBEDDING_MODEL
    : embeddingService.providerName === 'openai'
      ? config.OPENAI_EMBEDDING_MODEL
      : 'fallback',
  embeddingSchemaVersion: EMBEDDING_SCHEMA_VERSION,
});

export type IngestionInput = {
  fileAssetId: string;
  companyId: string;
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  sourceUrl: string;
  uploaderUserId: string;
  allowedRoles: string[];
};

class DocumentIngestionPipeline {
  async ingest(input: IngestionInput): Promise<void> {
    await prisma.fileAsset.update({
      where: { id: input.fileAssetId },
      data: { ingestionStatus: 'processing', ingestionError: null },
    });

    try {
      await vectorDocumentRepository.deleteBySource({
        companyId: input.companyId,
        sourceType: 'file_document',
        sourceId: input.fileAssetId,
      });
      await qdrantAdapter.deleteVectorsBySource({
        companyId: input.companyId,
        sourceType: 'file_document',
        sourceId: input.fileAssetId,
      });

      const modality = embeddingService.modalityForMimeType(input.mimeType);
      const records = modality === 'text'
        ? await this.buildTextRecords(input)
        : await this.buildMediaRecords(input, modality);

      if (records.length === 0) {
        throw new Error('No indexable content was produced for this asset');
      }

      await vectorDocumentRepository.upsertMany(records);
      await qdrantAdapter.upsertVectors(records);

      await prisma.fileAsset.update({
        where: { id: input.fileAssetId },
        data: { ingestionStatus: 'done' },
      });

      logger.info('document.ingestion.complete', {
        fileAssetId: input.fileAssetId,
        chunks: records.length,
        modality,
        companyId: input.companyId,
        allowedRoles: input.allowedRoles,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      await prisma.fileAsset.update({
        where: { id: input.fileAssetId },
        data: { ingestionStatus: 'failed', ingestionError: message },
      });
      logger.error('document.ingestion.error', {
        fileAssetId: input.fileAssetId,
        error: message,
      });
      throw error;
    }
  }

  private async buildTextRecords(input: IngestionInput) {
    const rawText = await extractTextFromBuffer(input.buffer, input.mimeType, input.fileName);
    const truncatedText = normalizeExtractedText(rawText);

    if (!truncatedText) {
      throw new Error('No extractable text was found in this file');
    }

    const chunks = chunkText(truncatedText);
    const embeddings = await embeddingService.embedText(chunks);
    const basePayload = buildBasePayload(input);

    return chunks.map((chunk, index) => ({
      companyId: input.companyId,
      sourceType: 'file_document' as const,
      sourceId: input.fileAssetId,
      chunkIndex: index,
      contentHash: hashContent(chunk),
      visibility: 'shared' as const,
      ownerUserId: input.uploaderUserId,
      fileAssetId: input.fileAssetId,
      allowedRoles: input.allowedRoles,
      payload: {
        ...basePayload,
        modality: 'text',
        _chunk: chunk,
        text: chunk,
      },
      embedding: embeddings[index],
    }));
  }

  private async buildMediaRecords(input: IngestionInput, modality: 'image' | 'video') {
    const embeddedSummary = await embeddingService.embedMediaSummary({
      mimeType: input.mimeType,
      fileName: input.fileName,
      buffer: input.buffer,
      cloudinaryUrl: input.sourceUrl,
    });
    const basePayload = buildBasePayload(input);

    return [{
      companyId: input.companyId,
      sourceType: 'file_document' as const,
      sourceId: input.fileAssetId,
      chunkIndex: 0,
      contentHash: hashContent(embeddedSummary.summary),
      visibility: 'shared' as const,
      ownerUserId: input.uploaderUserId,
      fileAssetId: input.fileAssetId,
      allowedRoles: input.allowedRoles,
      payload: {
        ...basePayload,
        modality,
        text: embeddedSummary.summary,
        mediaSummary: embeddedSummary.summary,
        segmentStartMs: 0,
        ...(modality === 'video' ? { segmentEndMs: null } : {}),
        ...(embeddedSummary.metadata ?? {}),
      },
      embedding: embeddedSummary.embedding,
    }];
  }
}

export const documentIngestionPipeline = new DocumentIngestionPipeline();
