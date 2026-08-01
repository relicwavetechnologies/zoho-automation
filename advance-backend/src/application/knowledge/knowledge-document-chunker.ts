import { createHash } from 'node:crypto';
import type {
  KnowledgeDocumentChunkInput,
  ParsedKnowledgeDocument,
  ParsedKnowledgeUnit,
} from './knowledge-document.port';

export interface KnowledgeDocumentChunkingOptions {
  readonly targetChars: number;
  readonly maxChars: number;
  readonly overlapChars: number;
  readonly maxChunks: number;
  readonly maxExtractedChars: number;
}

export const DEFAULT_KNOWLEDGE_DOCUMENT_CHUNKING: KnowledgeDocumentChunkingOptions = {
  targetChars: 2_800,
  maxChars: 3_600,
  overlapChars: 320,
  maxChunks: 2_000,
  maxExtractedChars: 4_000_000,
};

interface Segment {
  readonly text: string;
  readonly pageNumber?: number;
  readonly sectionPath: readonly string[];
}

/** Deterministic layout-aware chunking shared by every document format. */
export function chunkKnowledgeDocument(
  document: ParsedKnowledgeDocument,
  overrides: Partial<KnowledgeDocumentChunkingOptions> = {},
): KnowledgeDocumentChunkInput[] {
  const options = { ...DEFAULT_KNOWLEDGE_DOCUMENT_CHUNKING, ...overrides };
  validateOptions(options);
  const segments = document.units.flatMap(unit => splitUnit(unit, options.maxChars));
  const extractedChars = segments.reduce((sum, segment) => sum + segment.text.length, 0);
  if (extractedChars < 1) throw new Error('The document contains no searchable text.');
  if (extractedChars > options.maxExtractedChars) {
    throw new Error(`Extracted document text exceeds ${options.maxExtractedChars} characters.`);
  }

  const chunks: Segment[][] = [];
  let current: Segment[] = [];
  let currentChars = 0;
  let currentIsEmittedOverlap = false;
  for (const segment of segments) {
    const separator = current.length > 0 ? 2 : 0;
    if (current.length > 0 && currentChars + separator + segment.text.length > options.maxChars) {
      if (!currentIsEmittedOverlap) chunks.push(current);
      const availableOverlap = Math.max(0, options.maxChars - segment.text.length - 2);
      current = overlapTail(current, Math.min(options.overlapChars, availableOverlap));
      currentChars = joinedLength(current);
    }
    current.push(segment);
    currentIsEmittedOverlap = false;
    currentChars += (current.length > 1 ? 2 : 0) + segment.text.length;
    if (currentChars >= options.targetChars) {
      chunks.push(current);
      current = overlapTail(current, options.overlapChars);
      currentChars = joinedLength(current);
      currentIsEmittedOverlap = true;
    }
    if (chunks.length > options.maxChunks) {
      throw new Error(`Document requires more than ${options.maxChunks} searchable chunks.`);
    }
  }
  if (current.length > 0 && !currentIsEmittedOverlap && !sameSegments(current, chunks.at(-1))) {
    chunks.push(current);
  }
  if (chunks.length > options.maxChunks) {
    throw new Error(`Document requires more than ${options.maxChunks} searchable chunks.`);
  }

  return chunks.map((segmentsInChunk, ordinal) => {
    const text = segmentsInChunk.map(segment => segment.text).join('\n\n').trim();
    const pages = segmentsInChunk.flatMap(segment => segment.pageNumber === undefined ? [] : [segment.pageNumber]);
    const sectionPath = mostSpecificSection(segmentsInChunk);
    return {
      ordinal,
      text,
      textHash: createHash('sha256').update(text).digest('hex'),
      charCount: text.length,
      tokenEstimate: Math.max(1, Math.ceil(text.length / 4)),
      ...(pages.length > 0 ? { pageStart: Math.min(...pages), pageEnd: Math.max(...pages) } : {}),
      sectionPath,
    };
  });
}

function splitUnit(unit: ParsedKnowledgeUnit, maxChars: number): Segment[] {
  const normalized = normalizeText(unit.text);
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/u).flatMap(paragraph =>
    paragraph.length <= maxChars ? [paragraph] : splitLongText(paragraph, maxChars),
  );
  let sectionPath = [...(unit.sectionPath ?? [])].map(value => value.trim()).filter(Boolean).slice(-8);
  return paragraphs.flatMap(paragraph => {
    const heading = inferredHeading(paragraph);
    if (heading) {
      sectionPath = [...sectionPath.slice(0, 7), heading];
      return [];
    }
    return [{
      text: paragraph.trim(),
      ...(unit.pageNumber === undefined ? {} : { pageNumber: unit.pageNumber }),
      sectionPath,
    }];
  });
}

function splitLongText(value: string, maxChars: number): string[] {
  const parts: string[] = [];
  let remaining = value.trim();
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
    const newline = window.lastIndexOf('\n');
    const whitespace = window.lastIndexOf(' ');
    const boundary = Math.max(sentence >= Math.floor(maxChars * 0.55) ? sentence + 1 : -1, newline, whitespace);
    const cut = boundary >= Math.floor(maxChars * 0.4) ? boundary : maxChars;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function overlapTail(segments: readonly Segment[], maxChars: number): Segment[] {
  if (maxChars === 0) return [];
  const tail: Segment[] = [];
  let chars = 0;
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index]!;
    if (tail.length > 0 && chars + 2 + segment.text.length > maxChars) break;
    if (tail.length === 0 && segment.text.length > maxChars) {
      tail.unshift({ ...segment, text: segment.text.slice(-maxChars) });
      break;
    }
    tail.unshift(segment);
    chars += (tail.length > 1 ? 2 : 0) + segment.text.length;
  }
  return tail;
}

function inferredHeading(paragraph: string): string | null {
  const value = paragraph.trim();
  const markdown = /^(?:#{1,6}\s+)(.{1,180})$/u.exec(value)?.[1]?.trim();
  if (markdown) return markdown;
  if (value.includes('\n') || value.length > 140 || /[.!?]$/u.test(value)) return null;
  const words = value.split(/\s+/u);
  if (words.length > 14) return null;
  const letters = value.replace(/[^\p{L}]/gu, '');
  const upper = letters.replace(/[^\p{Lu}]/gu, '');
  return letters.length >= 3 && upper.length / letters.length >= 0.75 ? value : null;
}

function mostSpecificSection(segments: readonly Segment[]): readonly string[] {
  return segments.reduce<readonly string[]>((best, segment) =>
    segment.sectionPath.length > best.length ? segment.sectionPath : best,
  []);
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\u00a0]+/gu, ' ')
    .replace(/[ ]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function joinedLength(segments: readonly Segment[]): number {
  return segments.reduce((sum, segment, index) => sum + segment.text.length + (index > 0 ? 2 : 0), 0);
}

function sameSegments(left: readonly Segment[], right: readonly Segment[] | undefined): boolean {
  return Boolean(right) && left.length === right!.length && left.every((segment, index) => segment === right![index]);
}

function validateOptions(options: KnowledgeDocumentChunkingOptions): void {
  if (
    !Number.isInteger(options.targetChars)
    || !Number.isInteger(options.maxChars)
    || !Number.isInteger(options.overlapChars)
    || options.targetChars < 200
    || options.maxChars < options.targetChars
    || options.overlapChars < 0
    || options.overlapChars >= options.targetChars
    || options.maxChunks < 1
    || options.maxExtractedChars < options.maxChars
  ) throw new Error('Knowledge document chunking configuration is invalid.');
}
