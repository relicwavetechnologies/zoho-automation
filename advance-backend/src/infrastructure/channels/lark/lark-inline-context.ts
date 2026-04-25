/**
 * Extracts a lightweight inline context string from a Lark attachment
 * for injection into the current conversation turn so the LLM can
 * immediately reason about the file without waiting for full indexing.
 *
 * Images  → OCR text via GPT-4o vision (capped at 400 words)
 * Docs    → first page only (capped at 1 200 chars)
 * Others  → just the filename
 */

import type { LarkAttachment } from './lark-attachment.parser';
import type { TypedEnv } from '../../../config/env';
import type { Logger } from '../../../shared/logger';

const INLINE_TIMEOUT_MS = 10_000;
const DOC_CHAR_CAP      = 1_200;
const IMG_WORD_CAP      = 400;

export async function extractAttachmentInlineContext(
  attachment: LarkAttachment,
  fileBuffer:  Buffer,
  env:         TypedEnv,
  logger:      Logger,
): Promise<string> {
  const log = logger.child({ fn: 'extractAttachmentInlineContext', fileName: attachment.fileName });

  try {
    if (attachment.type === 'image') {
      return await withTimeout(
        extractImageContext(fileBuffer, attachment.mimeType, env),
        INLINE_TIMEOUT_MS,
        `[Image: ${attachment.fileName}]`,
      );
    }

    // File: try to extract first-page text
    return await withTimeout(
      extractDocContext(fileBuffer, attachment.mimeType, attachment.fileName),
      INLINE_TIMEOUT_MS,
      `[File: ${attachment.fileName}]`,
    );
  } catch (e) {
    log.warn('lark.inline_context.failed', { error: String(e) });
    return `[${attachment.type === 'image' ? 'Image' : 'File'}: ${attachment.fileName}]`;
  }
}

async function extractImageContext(buf: Buffer, mimeType: string, env: TypedEnv): Promise<string> {
  const { extractImageText } = await import('../../../application/ingestion/text-extraction/image-ocr.extractor');
  const geminiApiKey = env.GEMINI_API_KEY ?? env.GOOGLE_GENERATIVE_AI_API_KEY ?? '';
  const { ocrText, caption } = await extractImageText(buf, mimeType, geminiApiKey);

  const parts: string[] = [];
  if (caption) parts.push(`Description: ${caption.split(/\s+/).slice(0, IMG_WORD_CAP).join(' ')}`);
  if (ocrText)  parts.push(`OCR text: ${ocrText.split(/\s+/).slice(0, IMG_WORD_CAP).join(' ')}`);

  return `[Image:\n${parts.join('\n')}]`;
}

async function extractDocContext(buf: Buffer, mimeType: string, fileName: string): Promise<string> {
  let text = '';

  if (mimeType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) {
    const { extractPdfText } = await import('../../../application/ingestion/text-extraction/pdf.extractor');
    const full = await extractPdfText(buf);
    text = full.slice(0, DOC_CHAR_CAP * 3);
  } else if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword' ||
    fileName.toLowerCase().endsWith('.docx') ||
    fileName.toLowerCase().endsWith('.doc')
  ) {
    const { extractDocxText } = await import('../../../application/ingestion/text-extraction/docx.extractor');
    text = await extractDocxText(buf);
  } else if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    const { decodeTextBuffer } = await import('../../../application/ingestion/text-extraction/text-decode');
    text = decodeTextBuffer(buf);
  } else {
    return `[File: ${fileName}]`;
  }

  const excerpt = text.slice(0, DOC_CHAR_CAP).trim();
  const truncated = text.length > DOC_CHAR_CAP;
  return `[Document excerpt from "${fileName}"${truncated ? ' (first page)' : ''}:\n${excerpt}${truncated ? '\n…' : ''}]`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}
