import { createHash } from 'crypto';

import { prisma } from '../../utils/prisma';
import config from '../../config';
import { logger } from '../../utils/logger';
import { embeddingService } from '../../company/integrations/embedding';
import {
  buildCanonicalFileChunks,
  qdrantAdapter,
  vectorDocumentRepository,
} from '../../company/integrations/vector';
import { extractTextFromBuffer, normalizeExtractedText } from './document-text-extractor';

const hashContent = (content: string): string => createHash('sha256').update(content).digest('hex');

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
      const records =
        modality === 'text'
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

    const chunks = buildCanonicalFileChunks({
      companyId: input.companyId,
      fileAssetId: input.fileAssetId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sourceUrl: input.sourceUrl,
      uploaderUserId: input.uploaderUserId,
      allowedRoles: input.allowedRoles,
      text: truncatedText,
      metadata: {
        embeddingProvider: embeddingService.providerName,
        embeddingModel:
          embeddingService.providerName === 'gemini'
            ? config.GEMINI_EMBEDDING_MODEL
            : embeddingService.providerName === 'openai'
              ? config.OPENAI_EMBEDDING_MODEL
              : 'fallback',
        multimodalEmbeddingModel: config.GEMINI_MULTIMODAL_EMBEDDING_MODEL,
      },
    });
    const denseEmbeddings = await embeddingService.embedDocuments(
      chunks.map((chunk) => ({
        title: chunk.title,
        text: chunk.chunkText,
      })),
    );

    return chunks.map((chunk, index) => ({
      companyId: input.companyId,
      sourceType: 'file_document' as const,
      sourceId: input.fileAssetId,
      chunkIndex: chunk.chunkIndex,
      documentKey: chunk.documentKey,
      chunkText: chunk.chunkText,
      contentHash: hashContent(chunk.chunkText),
      visibility: chunk.visibility,
      ownerUserId: input.uploaderUserId,
      fileAssetId: input.fileAssetId,
      allowedRoles: input.allowedRoles,
      payload: {
        ...chunk.payload,
        _chunk: chunk.chunkText,
      },
      embedding: denseEmbeddings[index],
      denseEmbedding: denseEmbeddings[index],
      updatedAt: chunk.sourceUpdatedAt,
      embeddingSchemaVersion: chunk.embeddingSchemaVersion,
      retrievalProfile: chunk.retrievalProfile,
      sourceUpdatedAt: chunk.sourceUpdatedAt,
      title: chunk.title,
      content: chunk.chunkText,
    }));
  }

  private async buildMediaRecords(input: IngestionInput, modality: 'image' | 'video') {
    const embeddedSummary = await embeddingService.embedMediaSummary({
      mimeType: input.mimeType,
      fileName: input.fileName,
      buffer: input.buffer,
      cloudinaryUrl: input.sourceUrl,
    });
    const [denseEmbedding] = await embeddingService.embedDocuments([
      {
        title: input.fileName,
        text: embeddedSummary.summary,
      },
    ]);
    const [chunk] = buildCanonicalFileChunks({
      companyId: input.companyId,
      fileAssetId: input.fileAssetId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sourceUrl: input.sourceUrl,
      uploaderUserId: input.uploaderUserId,
      allowedRoles: input.allowedRoles,
      text: embeddedSummary.summary,
      metadata: {
        ...embeddedSummary.metadata,
        embeddingProvider: embeddingService.providerName,
        embeddingModel: config.GEMINI_EMBEDDING_MODEL,
        multimodalEmbeddingModel: config.GEMINI_MULTIMODAL_EMBEDDING_MODEL,
      },
    });

    return [
      {
        companyId: input.companyId,
        sourceType: 'file_document' as const,
        sourceId: input.fileAssetId,
        chunkIndex: 0,
        documentKey: chunk.documentKey,
        chunkText: chunk.chunkText,
        contentHash: hashContent(chunk.chunkText),
        visibility: chunk.visibility,
        ownerUserId: input.uploaderUserId,
        fileAssetId: input.fileAssetId,
        allowedRoles: input.allowedRoles,
        payload: {
          ...chunk.payload,
          _chunk: chunk.chunkText,
        },
        embedding: denseEmbedding,
        denseEmbedding,
        updatedAt: chunk.sourceUpdatedAt,
        embeddingSchemaVersion: chunk.embeddingSchemaVersion,
        retrievalProfile: chunk.retrievalProfile,
        sourceUpdatedAt: chunk.sourceUpdatedAt,
        title: chunk.title,
        content: chunk.chunkText,
      },
    ];
  }
}

export const documentIngestionPipeline = new DocumentIngestionPipeline();
