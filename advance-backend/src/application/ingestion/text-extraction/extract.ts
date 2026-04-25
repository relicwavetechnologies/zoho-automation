import { extractPdfText }     from './pdf.extractor';
import { extractDocxText }    from './docx.extractor';
import { extractXlsxText }    from './xlsx.extractor';
import { extractTabularText } from './tabular.extractor';
import { decodeTextBuffer }   from './text-decode';
import { extractImageText }   from './image-ocr.extractor';

export type FileModality = 'text' | 'image';

export interface ExtractedContent {
  modality:  FileModality;
  text:      string;
  /** For images: concise caption used as embedding anchor. */
  caption?:  string;
  /** Raw buffer forwarded to the multimodal embedder (images only). */
  imageBuffer?: Buffer;
  imageMime?:   string;
}

const IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif',
  'image/webp', 'image/bmp', 'image/tiff',
]);

const PDF_MIMES = new Set(['application/pdf']);

const DOCX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
]);

const XLSX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

const CSV_MIMES = new Set(['text/csv', 'text/tab-separated-values', 'text/tsv']);

/**
 * Dispatch extraction by MIME type.
 * `maxWords` is a soft cap — extraction truncates cleanly to this word count.
 */
export async function extractFromBuffer(
  buf: Buffer,
  mimeType: string,
  geminiApiKey: string,
  maxWords = 100_000,
): Promise<ExtractedContent> {
  const mime = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';

  if (IMAGE_MIMES.has(mime)) {
    const { ocrText, caption } = await extractImageText(buf, mime, geminiApiKey);
    return {
      modality:    'image',
      text:        ocrText,
      caption,
      imageBuffer: buf,
      imageMime:   mime,
    };
  }

  let rawText: string;

  if (PDF_MIMES.has(mime)) {
    rawText = await extractPdfText(buf);
  } else if (DOCX_MIMES.has(mime)) {
    rawText = await extractDocxText(buf);
  } else if (XLSX_MIMES.has(mime)) {
    rawText = extractXlsxText(buf);
  } else if (CSV_MIMES.has(mime)) {
    rawText = extractTabularText(decodeTextBuffer(buf));
  } else {
    rawText = decodeTextBuffer(buf);
  }

  const truncated = softTruncateWords(rawText, maxWords);
  return { modality: 'text', text: truncated };
}

/** Truncate to `max` words at a word boundary without splitting mid-word. */
function softTruncateWords(text: string, max: number): string {
  const words = text.split(/\s+/);
  if (words.length <= max) return text;
  return words.slice(0, max).join(' ');
}
