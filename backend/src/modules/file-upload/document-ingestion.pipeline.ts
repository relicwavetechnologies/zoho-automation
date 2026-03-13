import { createHash } from 'crypto';

import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { embeddingService } from '../../company/integrations/embedding';
import { qdrantAdapter } from '../../company/integrations/vector/qdrant.adapter';
import { vectorDocumentRepository } from '../../company/integrations/vector/vector-document.repository';
import { extractTextFromBuffer, normalizeExtractedText } from './document-text-extractor';

const DOC_CHUNK_SIZE = 600;

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
      data: { ingestionStatus: 'processing' },
    });

    try {
      const rawText = await extractTextFromBuffer(input.buffer, input.mimeType, input.fileName);
      const truncatedText = normalizeExtractedText(rawText);

      if (!truncatedText) {
        logger.warn('document.ingestion.empty_text', {
          fileAssetId: input.fileAssetId,
          mimeType: input.mimeType,
        });
        await prisma.fileAsset.update({
          where: { id: input.fileAssetId },
          data: {
            ingestionStatus: 'failed',
            ingestionError: 'No extractable text was found in this file. If this is a scanned PDF or image-only document, retry with a text-readable source.',
          },
        });
        return;
      }

      const chunks = chunkText(truncatedText);
      const embeddings = await embeddingService.embed(chunks);

      const records = chunks.map((chunk, index) => ({
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
          citationType: 'file',
          citationTitle: input.fileName,
          sourceUrl: input.sourceUrl,
          fileName: input.fileName,
          mimeType: input.mimeType,
          cloudinaryUrl: input.sourceUrl,
          fileAssetId: input.fileAssetId,
          _chunk: chunk,
          allowedRoles: input.allowedRoles,
          text: chunk,
        },
        embedding: embeddings[index],
      }));

      await vectorDocumentRepository.upsertMany(records);
      await qdrantAdapter.upsertVectors(records);

      await prisma.fileAsset.update({
        where: { id: input.fileAssetId },
        data: { ingestionStatus: 'done' },
      });

      logger.info('document.ingestion.complete', {
        fileAssetId: input.fileAssetId,
        chunks: chunks.length,
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
}

export const documentIngestionPipeline = new DocumentIngestionPipeline();
