import { createHash } from 'crypto';

import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { embeddingService } from '../../company/integrations/embedding';
import { qdrantAdapter } from '../../company/integrations/vector/qdrant.adapter';
import { vectorDocumentRepository } from '../../company/integrations/vector/vector-document.repository';
import config from '../../config';

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

const extractTextFromBuffer = async (buffer: Buffer, mimeType: string, fileName: string): Promise<string> => {
  if (mimeType === 'application/pdf') {
    // pdf-parse v2.x: the default export is the parse function directly
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse') as (buffer: Buffer) => Promise<{ text: string }>;
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword'
  ) {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    return buffer.toString('utf-8');
  }

  if (mimeType.startsWith('image/')) {
    // Use OpenAI Vision API for OCR — uses OPENAI_API_KEY from environment
    const base64 = buffer.toString('base64');
    const apiKey = process.env.OPENAI_API_KEY ?? '';
    if (!apiKey) {
      logger.warn('document.ingestion.image.no_openai_key', { mimeType });
      return '';
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Extract all readable text from this image. Return only the extracted text, no commentary.',
              },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });

    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? '';
  }

  logger.warn('document.ingestion.unsupported_mime', { mimeType, fileName });
  return '';
};

export type IngestionInput = {
  fileAssetId: string;
  companyId: string;
  buffer: Buffer;
  mimeType: string;
  fileName: string;
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

      const maxWords = config.DOC_EXTRACT_MAX_WORDS;
      const words = rawText.trim().split(/\s+/);
      const truncatedText = words.length > maxWords
        ? words.slice(0, maxWords).join(' ')
        : rawText.trim();

      if (!truncatedText) {
        logger.warn('document.ingestion.empty_text', {
          fileAssetId: input.fileAssetId,
          mimeType: input.mimeType,
        });
        await prisma.fileAsset.update({
          where: { id: input.fileAssetId },
          data: { ingestionStatus: 'done' },
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
          fileName: input.fileName,
          mimeType: input.mimeType,
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
