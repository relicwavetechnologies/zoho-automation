import { createHash } from 'crypto';
import type { FileChunkingPlan } from './plans';
import { ACTIVE_EMBEDDING_SCHEMA_VERSION } from '../../../infrastructure/ai/vector/types';

// ─── Internal text helpers ───────────────────────────────────────────────────

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function toWords(value: string): string[] {
  return value.split(/\s+/).map(w => w.trim()).filter(w => w.length > 0);
}

function joinWords(words: string[]): string {
  return words.join(' ').trim();
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function estimateTokenCount(value: string): number {
  return Math.max(1, Math.ceil(toWords(value).length * 1.3));
}

function splitParagraphs(value: string): string[] {
  return normalizeWhitespace(value)
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

function splitSentences(value: string): string[] {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

function splitLongText(value: string, targetTokens: number): string[] {
  const words = toWords(value);
  if (words.length <= targetTokens) return [normalizeWhitespace(value)];

  const sentenceParts = splitSentences(value);
  if (sentenceParts.length > 1) {
    const chunks: string[] = [];
    let current: string[] = [];
    let currentWords = 0;
    for (const sentence of sentenceParts) {
      const wordCount = toWords(sentence).length;
      if (currentWords > 0 && currentWords + wordCount > targetTokens) {
        chunks.push(normalizeWhitespace(current.join(' ')));
        current = [sentence];
        currentWords = wordCount;
      } else {
        current.push(sentence);
        currentWords += wordCount;
      }
    }
    if (current.length > 0) chunks.push(normalizeWhitespace(current.join(' ')));
    return chunks.filter(c => c.length > 0);
  }

  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += targetTokens) {
    chunks.push(joinWords(words.slice(i, i + targetTokens)));
  }
  return chunks.filter(c => c.length > 0);
}

function chunkParagraphs(paragraphs: string[], targetTokens: number, overlapTokens: number): string[] {
  if (paragraphs.length === 0) return [];
  const expanded = paragraphs.flatMap(p => splitLongText(p, targetTokens));
  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(normalizeWhitespace(current.join('\n\n')));
    const trailingWords = toWords(current.join(' '));
    current = overlapTokens > 0
      ? [joinWords(trailingWords.slice(Math.max(0, trailingWords.length - overlapTokens)))]
      : [];
    currentWords = current.length > 0 ? toWords(current[0] ?? '').length : 0;
  };

  for (const para of expanded) {
    const wordCount = toWords(para).length;
    if (currentWords > 0 && currentWords + wordCount > targetTokens) flush();
    current.push(para);
    currentWords += wordCount;
  }
  flush();
  return chunks.filter(c => c.length > 0);
}

// ─── Section detection ──────────────────────────────────────────────────────

interface FileSection {
  id:     string;
  path:   string[];
  title:  string | undefined;
  blocks: string[];
}

function inferHeading(block: string): { level: number; title: string } | null {
  const trimmed = block.trim();
  if (!trimmed) return null;

  const markdown = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (markdown && markdown[1] && markdown[2]) return { level: markdown[1].length, title: markdown[2].trim() };

  const section = trimmed.match(/^section\s+(\d+(?:\.\d+)*)[:.\-]?\s+(.+)$/i);
  if (section && section[1] && section[2]) {
    return { level: Math.min(6, section[1].split('.').length + 1), title: `${section[1]} ${section[2].trim()}` };
  }

  const numbered = trimmed.match(/^(\d+(?:\.\d+){0,4}|[A-Z])[\).:\-]\s+(.+)$/);
  if (numbered && numbered[1] && toWords(trimmed).length <= 18) {
    return { level: Math.min(6, numbered[1].split('.').length + 1), title: trimmed };
  }

  const allCaps = trimmed.length <= 80 && /^[A-Z0-9 /&()-]+$/.test(trimmed) && !/[.!?]$/.test(trimmed);
  if (allCaps) return { level: 2, title: trimmed };

  return null;
}

function buildSections(text: string): FileSection[] {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map(b => b.trim()).filter(b => b.length > 0);
  const sections: FileSection[] = [];
  const path: string[] = [];
  let currentSection: FileSection | null = null;

  const ensureSection = () => {
    if (!currentSection) {
      const fallbackPath = path.length > 0 ? [...path] : ['Overview'];
      currentSection = {
        id:     stableHash(`section|${fallbackPath.join('>')}`),
        path:   fallbackPath,
        title:  fallbackPath[fallbackPath.length - 1] ?? 'Overview',
        blocks: [],
      };
      sections.push(currentSection);
    }
  };

  for (const block of blocks) {
    const heading = inferHeading(block);
    if (heading) {
      path.splice(Math.max(0, heading.level - 1));
      path[heading.level - 1] = heading.title;
      currentSection = {
        id:     stableHash(`section|${path.join('>')}`),
        path:   [...path],
        title:  heading.title,
        blocks: [],
      };
      sections.push(currentSection);
      continue;
    }
    ensureSection();
    currentSection!.blocks.push(block);
  }

  return sections.filter(s => s.blocks.length > 0);
}

// ─── Chunk record ────────────────────────────────────────────────────────────

interface FileChunkRecord {
  chunkText:          string;
  indexedText:        string;
  chunkIndex:         number;
  sectionPath:        string[] | undefined;
  parentSectionId:    string | undefined;
  parentSectionText:  string | undefined;
  contextPrefix:      string | undefined;
}

function buildContextPrefix(input: {
  title: string;
  mimeType: string;
  plan: FileChunkingPlan;
  sectionPath?: string[];
}): string | undefined {
  if (!input.plan.contextualEnrichment) return undefined;
  const parts = [`Document "${input.title}"`, `type ${input.plan.documentClass.replace(/_/g, ' ')}`];
  if (input.sectionPath?.length) parts.push(`section ${input.sectionPath.join(' > ')}`);
  if (input.mimeType === 'text/csv') parts.push('tabular document');
  return `${parts.join(', ')}.`;
}

function buildChunkRecords(input: {
  text: string;
  title: string;
  mimeType: string;
  plan: FileChunkingPlan;
}): FileChunkRecord[] {
  const normalized = normalizeWhitespace(input.text);
  if (!normalized) return [];

  if (input.plan.strategy === 'canonical_simple') {
    return chunkParagraphs(splitParagraphs(normalized), input.plan.childTargetTokens, input.plan.childOverlapTokens)
      .map((chunkText, chunkIndex) => ({
        chunkText, indexedText: chunkText, chunkIndex,
        sectionPath: undefined, parentSectionId: undefined, parentSectionText: undefined, contextPrefix: undefined,
      }));
  }

  if (input.plan.strategy === 'transcript_segment') {
    return chunkParagraphs(
      normalized.split(/\n(?=\[[0-9]{2}:[0-9]{2}|\w+:)/).map(p => normalizeWhitespace(p)).filter(p => p.length > 0),
      input.plan.childTargetTokens,
      input.plan.childOverlapTokens,
    ).map((chunkText, chunkIndex) => ({
      chunkText, indexedText: chunkText, chunkIndex,
      sectionPath: undefined, parentSectionId: undefined, parentSectionText: undefined, contextPrefix: undefined,
    }));
  }

  // semantic_heading + hybrid_structured
  const sections = buildSections(normalized);
  if (sections.length === 0) {
    return chunkParagraphs(splitParagraphs(normalized), input.plan.childTargetTokens, input.plan.childOverlapTokens)
      .map((chunkText, chunkIndex) => ({
        chunkText, indexedText: chunkText, chunkIndex,
        sectionPath: undefined, parentSectionId: undefined, parentSectionText: undefined, contextPrefix: undefined,
      }));
  }

  const records: FileChunkRecord[] = [];
  let nextChunkIndex = 0;

  for (const section of sections) {
    const parentPieces = [section.title, ...section.blocks].filter((p): p is string => Boolean(p?.trim()));
    const parentSectionText = normalizeWhitespace(parentPieces.join('\n\n'));
    const childParagraphs = chunkParagraphs(section.blocks, input.plan.childTargetTokens, input.plan.childOverlapTokens);

    for (const chunkText of childParagraphs) {
      const contextPrefix = buildContextPrefix({
        title: input.title, mimeType: input.mimeType, plan: input.plan, sectionPath: section.path,
      });
      const indexedText = normalizeWhitespace(
        [
          contextPrefix,
          section.path.length > 0 ? `Section path: ${section.path.join(' > ')}.` : '',
          chunkText,
        ].filter(Boolean).join('\n\n'),
      );
      records.push({
        chunkText,
        indexedText,
        chunkIndex: nextChunkIndex++,
        sectionPath: section.path,
        parentSectionId:   input.plan.hierarchical ? section.id : undefined,
        parentSectionText: input.plan.hierarchical ? parentSectionText : undefined,
        contextPrefix,
      });
    }
  }

  return records;
}

// ─── Public chunk type ────────────────────────────────────────────────────────

export interface IndexedFileChunk {
  id:                     string;
  sourceType:             'file_document';
  sourceId:               string;
  chunkIndex:             number;
  documentKey:            string;
  title:                  string;
  chunkText:              string;
  chunkTokenCount:        number;
  sectionPath:            string[] | undefined;
  sourceUpdatedAt:        string;
  visibility:             'personal' | 'shared' | 'public';
  ownerUserId:            string | undefined;
  fileAssetId:            string;
  retrievalProfile:       'file';
  embeddingSchemaVersion: string;
  payload:                Record<string, unknown>;
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function buildIndexedFileChunks(input: {
  companyId:     string;
  fileAssetId:   string;
  fileName:      string;
  mimeType:      string;
  sourceUrl:     string;
  uploaderUserId: string;
  visibility?:   'personal' | 'shared' | 'public';
  allowedRoles?: string[];
  text:          string;
  plan:          FileChunkingPlan;
  metadata?:     Record<string, unknown>;
}): IndexedFileChunk[] {
  const title       = input.fileName;
  const documentKey = `${input.companyId}:file_document:${input.fileAssetId}`;
  const sourceUpdatedAt = new Date().toISOString();

  const chunkRecords = buildChunkRecords({
    text: input.text, title, mimeType: input.mimeType, plan: input.plan,
  });
  if (chunkRecords.length === 0) return [];

  return chunkRecords.map(record => ({
    id: stableHash(`${input.companyId}|file_document|${input.fileAssetId}|${record.chunkIndex}|${record.indexedText}`),
    sourceType:             'file_document' as const,
    sourceId:               input.fileAssetId,
    chunkIndex:             record.chunkIndex,
    documentKey,
    title,
    chunkText:              record.indexedText,
    chunkTokenCount:        estimateTokenCount(record.indexedText),
    sectionPath:            record.sectionPath,
    sourceUpdatedAt,
    visibility:             input.visibility ?? 'shared',
    ownerUserId:            input.uploaderUserId,
    fileAssetId:            input.fileAssetId,
    retrievalProfile:       'file' as const,
    embeddingSchemaVersion: ACTIVE_EMBEDDING_SCHEMA_VERSION,
    payload: {
      citationType:     'file',
      citationTitle:    title,
      fileName:         input.fileName,
      mimeType:         input.mimeType,
      cloudinaryUrl:    input.sourceUrl,
      sourceUrl:        input.sourceUrl,
      fileAssetId:      input.fileAssetId,
      documentKey,
      allowedRoles:     input.allowedRoles ?? [],
      title,
      text:             record.indexedText,
      chunkText:        record.indexedText,
      rawChunkText:     record.chunkText,
      indexedChunkText: record.indexedText,
      parentSectionId:  record.parentSectionId,
      parentSectionText: record.parentSectionText,
      sectionPath:      record.sectionPath ?? [],
      contextPrefix:    record.contextPrefix,
      documentClass:    input.plan.documentClass,
      chunkingStrategy: input.plan.strategy,
      hierarchical:     input.plan.hierarchical,
      contextualEnrichmentApplied: Boolean(record.contextPrefix),
      modality: input.mimeType.startsWith('image/') ? 'image' : input.mimeType.startsWith('video/') ? 'video' : 'text',
      embeddingSchemaVersion: ACTIVE_EMBEDDING_SCHEMA_VERSION,
      retrievalProfile: 'file',
      sourceUpdatedAt,
      ...(input.metadata ?? {}),
    },
  }));
}
