import { extractPdfText }     from './pdf.extractor';
import { extractDocxText }    from './docx.extractor';
import { extractXlsxText }    from './xlsx.extractor';
import { extractTabularText } from './tabular.extractor';
import { decodeTextBuffer }   from './text-decode';
import {
  extractImageText,
  extractImageTextWithProvider,
  type ExtractImageTextOptions,
} from './image-ocr.extractor';

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

const CSV_MIMES  = new Set(['text/csv', 'text/tab-separated-values', 'text/tsv']);
const HTML_MIMES = new Set(['text/html', 'application/xhtml+xml']);

/**
 * Dispatch extraction by MIME type.
 * `maxWords` is a soft cap — extraction truncates cleanly to this word count.
 * `fileName` is used as a fallback when MIME is `application/octet-stream`.
 */
export async function extractFromBuffer(
  buf: Buffer,
  mimeType: string,
  geminiApiKey: string,
  maxWords = 100_000,
  fileName?: string,
  visionModel?: string,
  imageOcrOptions?: ExtractImageTextOptions,
): Promise<ExtractedContent> {
  const mime = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  const lowerName = (fileName ?? '').toLowerCase();

  if (IMAGE_MIMES.has(mime)) {
    const { ocrText, caption } = imageOcrOptions
      ? await extractImageTextWithProvider(buf, mime, imageOcrOptions)
      : await extractImageText(buf, mime, geminiApiKey, visionModel);
    return {
      modality:    'image',
      text:        ocrText,
      caption,
      imageBuffer: buf,
      imageMime:   mime,
    };
  }

  let rawText: string;

  if (PDF_MIMES.has(mime) || lowerName.endsWith('.pdf')) {
    rawText = await extractPdfText(buf);
  } else if (DOCX_MIMES.has(mime) || lowerName.endsWith('.docx') || lowerName.endsWith('.doc')) {
    rawText = await extractDocxText(buf);
  } else if (XLSX_MIMES.has(mime) || lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {
    rawText = extractXlsxText(buf);
  } else if (CSV_MIMES.has(mime) || lowerName.endsWith('.csv') || lowerName.endsWith('.tsv')) {
    rawText = extractTabularText(decodeTextBuffer(buf));
  } else if (HTML_MIMES.has(mime) || lowerName.endsWith('.html') || lowerName.endsWith('.htm')) {
    rawText = htmlToText(decodeTextBuffer(buf));
  } else {
    rawText = decodeTextBuffer(buf);
  }

  const truncated = softTruncateWords(rawText, maxWords);
  return { modality: 'text', text: truncated };
}

/** Strip HTML tags, style/script blocks, and decode common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th|section|article|header|footer|nav|main)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s*\n\s*/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Truncate to `max` words at a word boundary without splitting mid-word. */
function softTruncateWords(text: string, max: number): string {
  const words = text.split(/\s+/);
  if (words.length <= max) return text;
  return words.slice(0, max).join(' ');
}
