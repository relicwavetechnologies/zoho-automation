/**
 * Extracts inline context from a Lark attachment for injection into the
 * current conversation turn so the LLM can reason about the file immediately.
 *
 * Small files  (< INLINE_FULL_CHAR_CAP chars of extracted text) → full content
 * Large files  (≥ INLINE_FULL_CHAR_CAP)                         → first page + search hint
 * Images                                                         → OCR + description (capped)
 * Unknown binary                                                 → filename only
 */

import type { LarkAttachment } from './lark-attachment.parser';
import type { TypedEnv }       from '../../../config/env';
import type { Logger }         from '../../../shared/logger';

const INLINE_TIMEOUT_MS   = 12_000;
const INLINE_FULL_CHAR_CAP = 6_000;   // files smaller than this get full content inline
const INLINE_EXCERPT_CHARS = 2_000;   // excerpt size for large files
const IMG_WORD_CAP         = 500;

export interface InlineContextResult {
  /** The formatted context string to inject into the message. */
  context: string;
  /** True when the full file content is included (no truncation). */
  isComplete: boolean;
  /** Extracted plain text (unformatted, used by callers for further processing). */
  rawText: string;
}

export async function extractAttachmentInlineContext(
  attachment: LarkAttachment,
  fileBuffer:  Buffer,
  env:         TypedEnv,
  logger:      Logger,
): Promise<InlineContextResult> {
  const log = logger.child({ fn: 'extractAttachmentInlineContext', fileName: attachment.fileName });

  try {
    if (attachment.type === 'image') {
      return await withTimeout(
        extractImageContext(fileBuffer, attachment.mimeType, attachment.fileName, env),
        INLINE_TIMEOUT_MS,
        { context: `[Image: ${attachment.fileName}]`, isComplete: false, rawText: '' },
      );
    }

    return await withTimeout(
      extractDocContext(
        fileBuffer, attachment.mimeType, attachment.fileName,
        env.LARK_DOCUMENT_INDEXING === 'on',
      ),
      INLINE_TIMEOUT_MS,
      { context: `[File: ${attachment.fileName}]`, isComplete: false, rawText: '' },
    );
  } catch (e) {
    log.warn('lark.inline_context.failed', { error: String(e) });
    const label = attachment.type === 'image' ? 'Image' : 'File';
    return { context: `[${label}: ${attachment.fileName}]`, isComplete: false, rawText: '' };
  }
}

async function extractImageContext(
  buf:      Buffer,
  mimeType: string,
  fileName: string,
  env:      TypedEnv,
): Promise<InlineContextResult> {
  const { extractImageTextWithProvider } = await import('../../../application/ingestion/text-extraction/image-ocr.extractor');
  const { ocrText, caption } = await extractImageTextWithProvider(buf, mimeType, {
    provider: env.IMAGE_OCR_PROVIDER,
    geminiApiKey: env.GEMINI_API_KEY ?? env.GOOGLE_GENERATIVE_AI_API_KEY,
    openrouterApiKey: env.OPENROUTER_API_KEY,
    visionModel: env.IMAGE_OCR_PROVIDER === 'openrouter'
      ? env.OPENROUTER_VISION_MODEL
      : env.GEMINI_VISION_MODEL,
    openrouterProviderOrder: env.OPENROUTER_PROVIDER_ORDER,
  });

  const parts: string[] = [];
  if (caption) parts.push(`Description: ${caption.split(/\s+/).slice(0, IMG_WORD_CAP).join(' ')}`);
  if (ocrText)  parts.push(`OCR text:\n${ocrText.split(/\s+/).slice(0, IMG_WORD_CAP).join(' ')}`);

  const rawText = [caption, ocrText].filter(Boolean).join('\n');
  const context = `[Image: "${fileName}"\n${parts.join('\n')}]`;
  return { context, isComplete: true, rawText };
}

async function extractDocContext(
  buf:      Buffer,
  mimeType: string,
  fileName: string,
  /** Whether a background index will exist to search. See LARK_DOCUMENT_INDEXING. */
  indexingEnabled: boolean,
): Promise<InlineContextResult> {
  const lowerName = fileName.toLowerCase();
  const mime      = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  let rawText     = '';

  if (mime === 'application/pdf' || lowerName.endsWith('.pdf')) {
    const { extractPdfText } = await import('../../../application/ingestion/text-extraction/pdf.extractor');
    rawText = await extractPdfText(buf);

  } else if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/msword' ||
    lowerName.endsWith('.docx') || lowerName.endsWith('.doc')
  ) {
    const { extractDocxText } = await import('../../../application/ingestion/text-extraction/docx.extractor');
    rawText = await extractDocxText(buf);

  } else if (
    mime === 'text/html' || mime === 'application/xhtml+xml' ||
    lowerName.endsWith('.html') || lowerName.endsWith('.htm')
  ) {
    const { decodeTextBuffer } = await import('../../../application/ingestion/text-extraction/text-decode');
    const { htmlToText }       = await import('../../../application/ingestion/text-extraction/extract');
    rawText = htmlToText(decodeTextBuffer(buf));

  } else if (
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel' ||
    lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')
  ) {
    const { extractXlsxText } = await import('../../../application/ingestion/text-extraction/xlsx.extractor');
    rawText = extractXlsxText(buf);

  } else if (
    mime === 'text/csv' || mime === 'text/tab-separated-values' || mime === 'text/tsv' ||
    lowerName.endsWith('.csv') || lowerName.endsWith('.tsv')
  ) {
    const { decodeTextBuffer }    = await import('../../../application/ingestion/text-extraction/text-decode');
    const { extractTabularText }  = await import('../../../application/ingestion/text-extraction/tabular.extractor');
    rawText = extractTabularText(decodeTextBuffer(buf));

  } else if (
    mime === 'text/plain' || mime === 'text/markdown' || mime === 'application/json' ||
    lowerName.endsWith('.md') || lowerName.endsWith('.txt') || lowerName.endsWith('.json')
  ) {
    const { decodeTextBuffer } = await import('../../../application/ingestion/text-extraction/text-decode');
    rawText = decodeTextBuffer(buf);

  } else {
    // Unknown — just tag with filename; worker will index it if possible
    return { context: `[File: "${fileName}"]`, isComplete: false, rawText: '' };
  }

  if (!rawText.trim()) {
    return { context: `[File: "${fileName}" — no text content extracted]`, isComplete: false, rawText: '' };
  }

  const isComplete = rawText.length <= INLINE_FULL_CHAR_CAP;
  const excerpt    = isComplete ? rawText : rawText.slice(0, INLINE_EXCERPT_CHARS).trimEnd();

  // What the model is told about the rest of a long document depends on
  // whether there is a rest to fetch. Pointing it at contextSearch when
  // indexing is off sends it after chunks that were never written, and it
  // reports the file as unreadable rather than answering from what it has.
  const truncatedContext = indexingEnabled
    ? `[Document excerpt from "${fileName}" (first section — full document indexed in background):\n${excerpt}\n…\nUse contextSearch or documentRag to look up specific sections.]`
    : `[Document excerpt from "${fileName}" (first section only — the rest of this file was NOT read):\n${excerpt}\n…\n`
      + 'This excerpt is everything you have of this file; it is not indexed, so searching for more will find nothing. '
      + 'Answer from the excerpt, and say plainly which parts of the document you could not see. '
      + 'Do not infer what the unread sections contain.]';

  const context = isComplete
    ? `[Document: "${fileName}"\n${rawText}]`
    : truncatedContext;

  return { context, isComplete, rawText };
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}
