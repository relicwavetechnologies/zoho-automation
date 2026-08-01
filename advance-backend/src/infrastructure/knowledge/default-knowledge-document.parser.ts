import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import type {
  KnowledgeDocumentParser,
  ParsedKnowledgeDocument,
  ParsedKnowledgeUnit,
} from '../../application/knowledge/knowledge-document.port';
import { KNOWLEDGE_DOCUMENT_PARSER_VERSION } from '../../application/knowledge/knowledge-document.port';

const execFileAsync = promisify(execFile);
const TEXT_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);
const IMAGE_MIME_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);

export interface KnowledgeImageOcr {
  extract(input: {
    readonly image: Buffer;
    readonly mimeType: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly text: string;
    readonly caption?: string;
    readonly confidence: number;
    readonly warnings: readonly string[];
  }>;
}

/** Parses approved governed files into layout-bearing text units. */
export class DefaultKnowledgeDocumentParser implements KnowledgeDocumentParser {
  constructor(private readonly options: {
    readonly ocr: KnowledgeImageOcr | null;
    readonly maxPages: number;
    readonly maxOcrPages: number;
    readonly maxArchiveEntries?: number;
    readonly maxArchiveUncompressedBytes?: number;
    readonly maxArchiveCompressionRatio?: number;
    readonly pdfRenderCommand?: string;
  }) {}

  async parse(input: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    signal: AbortSignal;
  }): Promise<ParsedKnowledgeDocument> {
    throwIfAborted(input.signal);
    if (TEXT_MIME_TYPES.has(input.mimeType)) return parseText(input.buffer, input.mimeType);
    if (input.mimeType === 'application/pdf') return this.parsePdf(input);
    if (input.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      this.assertSafeOfficeArchive(input.buffer);
      return parseDocx(input.buffer, input.signal);
    }
    if (input.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      this.assertSafeOfficeArchive(input.buffer);
      return parseWorkbook(input.buffer, this.options.maxPages);
    }
    if (input.mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
      this.assertSafeOfficeArchive(input.buffer);
      return parsePresentation(input.buffer, this.options.maxPages, input.signal);
    }
    if (IMAGE_MIME_TYPES.has(input.mimeType)) return this.parseImage(input);
    throw new Error(`No governed document parser is registered for ${input.mimeType}.`);
  }

  private assertSafeOfficeArchive(buffer: Buffer): void {
    assertSafeZipArchive(buffer, {
      maxEntries: this.options.maxArchiveEntries ?? 10_000,
      maxUncompressedBytes: this.options.maxArchiveUncompressedBytes ?? 100_000_000,
      maxCompressionRatio: this.options.maxArchiveCompressionRatio ?? 200,
    });
  }

  private async parseImage(input: {
    buffer: Buffer;
    mimeType: string;
    signal: AbortSignal;
  }): Promise<ParsedKnowledgeDocument> {
    if (!this.options.ocr) throw new Error('OCR is not configured for image knowledge.');
    const result = await withAbort(this.options.ocr.extract({
      image: input.buffer,
      mimeType: input.mimeType,
      signal: input.signal,
    }), input.signal);
    const text = [result.caption?.trim(), result.text.trim()].filter(Boolean).join('\n\n');
    return {
      units: text ? [{ text, pageNumber: 1 }] : [],
      pageCount: 1,
      warnings: [
        ...result.warnings,
        ...(result.confidence < 0.6 ? ['OCR confidence was below 0.6.'] : []),
      ],
      parserVersion: KNOWLEDGE_DOCUMENT_PARSER_VERSION,
    };
  }

  private async parsePdf(input: {
    buffer: Buffer;
    mimeType: string;
    signal: AbortSignal;
  }): Promise<ParsedKnowledgeDocument> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(input.buffer),
      isEvalSupported: false,
      useSystemFonts: true,
    });
    const units: ParsedKnowledgeUnit[] = [];
    const scanPages: number[] = [];
    const warnings: string[] = [];
    let pageCount = 0;
    try {
      const document = await withAbort(loadingTask.promise, input.signal);
      pageCount = document.numPages;
      if (pageCount > this.options.maxPages) {
        throw new Error(`PDF has ${pageCount} pages; the limit is ${this.options.maxPages}.`);
      }
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        throwIfAborted(input.signal);
        const page = await withAbort(document.getPage(pageNumber), input.signal);
        let text = '';
        try {
          const content = await withAbort(page.getTextContent(), input.signal);
          text = pdfText(content.items as readonly PdfTextItem[]);
        } finally {
          page.cleanup();
        }
        if (visibleTextLength(text) >= 24) units.push({ text, pageNumber });
        else scanPages.push(pageNumber);
      }
    } finally {
      await loadingTask.destroy();
    }

    if (scanPages.length > 0) {
      if (!this.options.ocr) {
        warnings.push(`${scanPages.length} PDF page(s) contained no selectable text and OCR is not configured.`);
      } else if (scanPages.length > this.options.maxOcrPages) {
        throw new Error(`PDF needs OCR on ${scanPages.length} pages; the limit is ${this.options.maxOcrPages}.`);
      } else {
        const ocrUnits = await this.ocrPdfPages(input.buffer, scanPages, input.signal);
        units.push(...ocrUnits.units);
        warnings.push(...ocrUnits.warnings);
      }
    }
    return {
      units: units.sort((left, right) => (left.pageNumber ?? 0) - (right.pageNumber ?? 0)),
      pageCount,
      warnings,
      parserVersion: KNOWLEDGE_DOCUMENT_PARSER_VERSION,
    };
  }

  private async ocrPdfPages(
    pdf: Buffer,
    pageNumbers: readonly number[],
    signal: AbortSignal,
  ): Promise<{ units: ParsedKnowledgeUnit[]; warnings: string[] }> {
    const workDir = await mkdtemp(join(tmpdir(), 'divo-knowledge-pdf-'));
    const pdfPath = join(workDir, 'source.pdf');
    const units: ParsedKnowledgeUnit[] = [];
    const warnings: string[] = [];
    try {
      await writeFile(pdfPath, pdf, { flag: 'wx' });
      for (const pageNumber of pageNumbers) {
        throwIfAborted(signal);
        const outputPrefix = join(workDir, `page-${pageNumber}`);
        await execFileAsync(this.options.pdfRenderCommand ?? 'pdftoppm', [
          '-f', String(pageNumber),
          '-l', String(pageNumber),
          '-singlefile',
          '-png',
          '-r', '150',
          pdfPath,
          outputPrefix,
        ], { signal, maxBuffer: 1_000_000 });
        const image = await readFile(`${outputPrefix}.png`);
        const result = await withAbort(
          this.options.ocr!.extract({ image, mimeType: 'image/png', signal }),
          signal,
        );
        const text = [result.caption?.trim(), result.text.trim()].filter(Boolean).join('\n\n');
        if (text) units.push({ text, pageNumber });
        warnings.push(...result.warnings.map(warning => `Page ${pageNumber}: ${warning}`));
        if (result.confidence < 0.6) warnings.push(`Page ${pageNumber}: OCR confidence was below 0.6.`);
      }
      return { units, warnings };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

interface PdfTextItem {
  readonly str?: string;
  readonly hasEOL?: boolean;
}

function parseText(buffer: Buffer, mimeType: string): ParsedKnowledgeDocument {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  const text = mimeType === 'application/json'
    ? JSON.stringify(JSON.parse(source), null, 2)
    : source;
  return {
    units: [{ text }],
    warnings: [],
    parserVersion: KNOWLEDGE_DOCUMENT_PARSER_VERSION,
  };
}

async function parseDocx(buffer: Buffer, signal: AbortSignal): Promise<ParsedKnowledgeDocument> {
  const result = await withAbort(
    mammoth.convertToHtml({ buffer }, { externalFileAccess: false }),
    signal,
  );
  return {
    units: [{ text: htmlToStructuredText(result.value) }],
    warnings: result.messages.map((message: { type: string; message: string }) => `${message.type}: ${message.message}`),
    parserVersion: KNOWLEDGE_DOCUMENT_PARSER_VERSION,
  };
}

function htmlToStructuredText(html: string): string {
  return html
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/giu, (_match, level: string, text: string) =>
      `\n\n${'#'.repeat(Number(level))} ${stripHtml(text)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/giu, (_match, text: string) => `\n- ${stripHtml(text)}`)
    .replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/giu, (_match, text: string) => ` | ${stripHtml(text)}`)
    .replace(/<\/(?:p|tr|table|ul|ol)>/giu, '\n\n')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function parseWorkbook(buffer: Buffer, maxSheets: number): ParsedKnowledgeDocument {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellDates: false,
    cellFormula: true,
    cellHTML: false,
  });
  if (workbook.SheetNames.length > maxSheets) {
    throw new Error(`Workbook has ${workbook.SheetNames.length} sheets; the limit is ${maxSheets}.`);
  }
  const units = workbook.SheetNames.flatMap((sheetName, index) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return [];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
    return csv ? [{ text: csv, pageNumber: index + 1, sectionPath: [sheetName] }] : [];
  });
  return {
    units,
    pageCount: workbook.SheetNames.length,
    warnings: [],
    parserVersion: KNOWLEDGE_DOCUMENT_PARSER_VERSION,
  };
}

async function parsePresentation(
  buffer: Buffer,
  maxSlides: number,
  signal: AbortSignal,
): Promise<ParsedKnowledgeDocument> {
  const zip = await withAbort(JSZip.loadAsync(buffer, { checkCRC32: true }), signal);
  const slides = Object.values(zip.files)
    .filter(file => !file.dir && /^ppt\/slides\/slide\d+\.xml$/u.test(file.name))
    .sort((left, right) => slideNumber(left.name) - slideNumber(right.name));
  if (slides.length > maxSlides) {
    throw new Error(`Presentation has ${slides.length} slides; the limit is ${maxSlides}.`);
  }
  const units: ParsedKnowledgeUnit[] = [];
  for (const slide of slides) {
    const xml = await withAbort(slide.async('string'), signal);
    const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)]
      .map(match => decodeXml(match[1] ?? ''))
      .filter(Boolean)
      .join('\n');
    if (text) units.push({ text, pageNumber: slideNumber(slide.name) });
  }
  return {
    units,
    pageCount: slides.length,
    warnings: [],
    parserVersion: KNOWLEDGE_DOCUMENT_PARSER_VERSION,
  };
}

function pdfText(items: readonly PdfTextItem[]): string {
  let text = '';
  for (const item of items) {
    const value = item.str?.trim();
    if (value) text += `${text && !text.endsWith('\n') ? ' ' : ''}${value}`;
    if (item.hasEOL) text += '\n';
  }
  return text.replace(/[ ]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function visibleTextLength(value: string): number {
  return value.replace(/[^\p{L}\p{N}]/gu, '').length;
}

function slideNumber(name: string): number {
  return Number(/slide(\d+)\.xml$/u.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
    .trim();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('Document parsing was aborted.');
}

function withAbort<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Document parsing was aborted.'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

interface ZipSafetyLimits {
  readonly maxEntries: number;
  readonly maxUncompressedBytes: number;
  readonly maxCompressionRatio: number;
}

/** Reads only ZIP central-directory metadata; payloads are not decompressed here. */
function assertSafeZipArchive(buffer: Buffer, limits: ZipSafetyLimits): void {
  const eocd = findZipEndOfCentralDirectory(buffer);
  if (eocd < 0 || eocd + 22 > buffer.length) throw new Error('Office archive has no valid ZIP directory.');
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (
    disk !== 0
    || centralDisk !== 0
    || diskEntries !== totalEntries
    || totalEntries === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
  ) throw new Error('Multi-disk and ZIP64 Office archives are not supported.');
  if (totalEntries < 1 || totalEntries > limits.maxEntries) {
    throw new Error(`Office archive has ${totalEntries} entries; the limit is ${limits.maxEntries}.`);
  }
  const centralEnd = centralOffset + centralSize;
  if (centralOffset > buffer.length || centralEnd > eocd || centralEnd < centralOffset) {
    throw new Error('Office archive ZIP directory is malformed.');
  }

  let cursor = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > centralEnd || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Office archive ZIP entry metadata is malformed.');
    }
    const compressed = buffer.readUInt32LE(cursor + 20);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new Error('ZIP64 Office archive entries are not supported.');
    }
    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    if (totalUncompressed > limits.maxUncompressedBytes) {
      throw new Error(
        `Office archive expands beyond ${limits.maxUncompressedBytes} bytes.`,
      );
    }
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  if (cursor !== centralEnd) throw new Error('Office archive ZIP directory length is inconsistent.');
  const ratio = totalUncompressed / Math.max(1, totalCompressed);
  if (ratio > limits.maxCompressionRatio) {
    throw new Error(`Office archive compression ratio ${ratio.toFixed(1)} exceeds ${limits.maxCompressionRatio}.`);
  }
}

function findZipEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  return -1;
}
