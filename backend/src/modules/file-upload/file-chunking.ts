import { createHash } from 'crypto';

import type { VectorUpsertDTO } from '../../company/contracts/dto';
import type { CanonicalRetrievalChunk } from '../../company/integrations/vector/retrieval-contract';
import { ACTIVE_EMBEDDING_SCHEMA_VERSION } from '../../company/integrations/vector/retrieval-contract';
import { retrievalFeatureFlags } from '../../company/retrieval/retrieval-feature-flags';

export const FILE_DOCUMENT_CLASSES = [
  'policy',
  'contract',
  'handbook',
  'sop',
  'finance_doc',
  'generic_text',
  'media_summary',
  'transcript',
] as const;

export type FileDocumentClass = (typeof FILE_DOCUMENT_CLASSES)[number];

export const FILE_CHUNKING_STRATEGIES = [
  'canonical_simple',
  'semantic_heading',
  'hybrid_structured',
  'transcript_segment',
] as const;

export type FileChunkingStrategy = (typeof FILE_CHUNKING_STRATEGIES)[number];

export type FileChunkingPlan = {
  documentClass: FileDocumentClass;
  strategy: FileChunkingStrategy;
  hierarchical: boolean;
  contextualEnrichment: boolean;
  childTargetTokens: number;
  childOverlapTokens: number;
  parentTargetTokens?: number;
};

type FileSection = {
  id: string;
  path: string[];
  title?: string;
  blocks: string[];
};

type FileChunkRecord = {
  chunkText: string;
  indexedText: string;
  chunkIndex: number;
  sectionPath?: string[];
  parentSectionId?: string;
  parentSectionText?: string;
  contextPrefix?: string;
};

const normalizeWhitespace = (value: string): string =>
  value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const toWords = (value: string): string[] =>
  value
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);

const joinWords = (words: string[]): string => words.join(' ').trim();

const stableHash = (value: string): string => createHash('sha256').update(value).digest('hex');

const estimateTokenCount = (value: string): number => Math.max(1, Math.ceil(toWords(value).length * 1.3));

const splitParagraphs = (value: string): string[] =>
  normalizeWhitespace(value)
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const splitSentences = (value: string): string[] => {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

const splitLongText = (value: string, targetTokens: number): string[] => {
  const words = toWords(value);
  if (words.length <= targetTokens) {
    return [normalizeWhitespace(value)];
  }

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
    if (current.length > 0) {
      chunks.push(normalizeWhitespace(current.join(' ')));
    }
    return chunks.filter((chunk) => chunk.length > 0);
  }

  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += targetTokens) {
    chunks.push(joinWords(words.slice(index, index + targetTokens)));
  }
  return chunks.filter((chunk) => chunk.length > 0);
};

const chunkParagraphs = (paragraphs: string[], targetTokens: number, overlapTokens: number): string[] => {
  if (paragraphs.length === 0) {
    return [];
  }

  const expanded = paragraphs.flatMap((paragraph) => splitLongText(paragraph, targetTokens));
  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(normalizeWhitespace(current.join('\n\n')));
    const trailingWords = toWords(current.join(' '));
    current =
      overlapTokens > 0
        ? [joinWords(trailingWords.slice(Math.max(0, trailingWords.length - overlapTokens)))]
        : [];
    currentWords = current.length > 0 ? toWords(current[0]).length : 0;
  };

  for (const paragraph of expanded) {
    const words = toWords(paragraph).length;
    if (currentWords > 0 && currentWords + words > targetTokens) {
      flush();
    }
    current.push(paragraph);
    currentWords += words;
  }

  flush();
  return chunks.filter((chunk) => chunk.length > 0);
};

const classifyByKeywords = (haystack: string, entries: string[]): boolean =>
  entries.some((entry) => haystack.includes(entry));

export const classifyFileDocument = (input: {
  fileName: string;
  mimeType: string;
  text: string;
}): FileDocumentClass => {
  if (input.mimeType.startsWith('image/') || input.mimeType.startsWith('video/')) {
    return 'media_summary';
  }

  const normalized = `${input.fileName}\n${input.text.slice(0, 6000)}`.toLowerCase();
  if (classifyByKeywords(normalized, ['transcript', 'speaker', 'meeting minutes', '[00:', 'timestamp'])) {
    return 'transcript';
  }
  if (classifyByKeywords(normalized, ['contract', 'agreement', 'msa', 'nda', 'terms and conditions', 'service level'])) {
    return 'contract';
  }
  if (classifyByKeywords(normalized, ['handbook', 'employee manual', 'employee guide'])) {
    return 'handbook';
  }
  if (classifyByKeywords(normalized, ['policy', 'policies', 'compliance', 'leave policy', 'refund policy'])) {
    return 'policy';
  }
  if (classifyByKeywords(normalized, ['sop', 'runbook', 'playbook', 'procedure', 'workflow', 'onboarding guide'])) {
    return 'sop';
  }
  if (classifyByKeywords(normalized, ['invoice', 'statement', 'reconciliation', 'balance', 'ledger', 'p&l', 'profit and loss', 'bank'])) {
    return 'finance_doc';
  }
  return 'generic_text';
};

export const chooseFileChunkingPlan = (input: {
  fileName: string;
  mimeType: string;
  text: string;
}): FileChunkingPlan => {
  const documentClass = classifyFileDocument(input);
  if (!retrievalFeatureFlags.advancedFileChunking || documentClass === 'media_summary') {
    return {
      documentClass,
      strategy: 'canonical_simple',
      hierarchical: false,
      contextualEnrichment: false,
      childTargetTokens: 900,
      childOverlapTokens: 180,
    };
  }

  if (documentClass === 'transcript') {
    return {
      documentClass,
      strategy: 'transcript_segment',
      hierarchical: false,
      contextualEnrichment: false,
      childTargetTokens: 320,
      childOverlapTokens: 48,
    };
  }

  if (documentClass === 'policy' || documentClass === 'contract' || documentClass === 'handbook' || documentClass === 'sop') {
    return {
      documentClass,
      strategy: 'hybrid_structured',
      hierarchical: true,
      contextualEnrichment: retrievalFeatureFlags.contextualEnrichment,
      childTargetTokens: 480,
      childOverlapTokens: 64,
      parentTargetTokens: 1400,
    };
  }

  if (documentClass === 'finance_doc') {
    return {
      documentClass,
      strategy: 'semantic_heading',
      hierarchical: true,
      contextualEnrichment: retrievalFeatureFlags.contextualEnrichment,
      childTargetTokens: 560,
      childOverlapTokens: 72,
      parentTargetTokens: 1200,
    };
  }

  return {
    documentClass,
    strategy: 'semantic_heading',
    hierarchical: false,
    contextualEnrichment: false,
    childTargetTokens: 720,
    childOverlapTokens: 96,
  };
};

const inferHeading = (block: string): { level: number; title: string } | null => {
  const trimmed = block.trim();
  if (!trimmed) return null;

  const markdown = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (markdown) {
    return { level: markdown[1].length, title: markdown[2].trim() };
  }

  const section = trimmed.match(/^section\s+(\d+(?:\.\d+)*)[:.\-]?\s+(.+)$/i);
  if (section) {
    return { level: Math.min(6, section[1].split('.').length + 1), title: `${section[1]} ${section[2].trim()}` };
  }

  const numbered = trimmed.match(/^(\d+(?:\.\d+){0,4}|[A-Z])[\).:\-]\s+(.+)$/);
  if (numbered && toWords(trimmed).length <= 18) {
    return { level: Math.min(6, numbered[1].split('.').length + 1), title: trimmed };
  }

  const allCaps = trimmed.length <= 80 && /^[A-Z0-9 /&()-]+$/.test(trimmed) && !/[.!?]$/.test(trimmed);
  if (allCaps) {
    return { level: 2, title: trimmed };
  }

  return null;
};

const buildSections = (text: string): FileSection[] => {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  const sections: FileSection[] = [];
  const path: string[] = [];
  let currentSection: FileSection | null = null;

  const ensureSection = () => {
    if (!currentSection) {
      const fallbackPath = path.length > 0 ? [...path] : ['Overview'];
      currentSection = {
        id: stableHash(`section|${fallbackPath.join('>')}`),
        path: fallbackPath,
        title: fallbackPath[fallbackPath.length - 1],
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
        id: stableHash(`section|${path.join('>')}`),
        path: [...path],
        title: heading.title,
        blocks: [],
      };
      sections.push(currentSection);
      continue;
    }

    ensureSection();
    currentSection.blocks.push(block);
  }

  return sections.filter((section) => section.blocks.length > 0);
};

const buildContextPrefix = (input: {
  title: string;
  mimeType: string;
  plan: FileChunkingPlan;
  sectionPath?: string[];
}): string | undefined => {
  if (!input.plan.contextualEnrichment) {
    return undefined;
  }

  const parts = [`Document "${input.title}"`, `type ${input.plan.documentClass.replace(/_/g, ' ')}`];
  if (input.sectionPath && input.sectionPath.length > 0) {
    parts.push(`section ${input.sectionPath.join(' > ')}`);
  }
  if (input.mimeType === 'text/csv') {
    parts.push('tabular document');
  }
  return `${parts.join(', ')}.`;
};

const buildChunkRecords = (input: {
  text: string;
  title: string;
  mimeType: string;
  plan: FileChunkingPlan;
}): FileChunkRecord[] => {
  const normalized = normalizeWhitespace(input.text);
  if (!normalized) {
    return [];
  }

  if (input.plan.strategy === 'canonical_simple') {
    return chunkParagraphs(splitParagraphs(normalized), input.plan.childTargetTokens, input.plan.childOverlapTokens)
      .map((chunkText, chunkIndex) => ({
        chunkText,
        indexedText: chunkText,
        chunkIndex,
      }));
  }

  if (input.plan.strategy === 'transcript_segment') {
    return chunkParagraphs(
      normalized
        .split(/\n(?=\[[0-9]{2}:[0-9]{2}|\w+:)/)
        .map((part) => normalizeWhitespace(part))
        .filter((part) => part.length > 0),
      input.plan.childTargetTokens,
      input.plan.childOverlapTokens,
    ).map((chunkText, chunkIndex) => ({
      chunkText,
      indexedText: chunkText,
      chunkIndex,
    }));
  }

  const sections = buildSections(normalized);
  if (sections.length === 0) {
    return chunkParagraphs(splitParagraphs(normalized), input.plan.childTargetTokens, input.plan.childOverlapTokens)
      .map((chunkText, chunkIndex) => ({
        chunkText,
        indexedText: chunkText,
        chunkIndex,
      }));
  }

  const records: FileChunkRecord[] = [];
  let nextChunkIndex = 0;
  for (const section of sections) {
    const parentPieces = [section.title, ...section.blocks].filter((part): part is string => Boolean(part && part.trim()));
    const parentSectionText = normalizeWhitespace(parentPieces.join('\n\n'));
    const childParagraphs = chunkParagraphs(
      section.blocks,
      input.plan.childTargetTokens,
      input.plan.childOverlapTokens,
    );

    for (const chunkText of childParagraphs) {
      const contextPrefix = buildContextPrefix({
        title: input.title,
        mimeType: input.mimeType,
        plan: input.plan,
        sectionPath: section.path,
      });
      const indexedText = normalizeWhitespace(
        [contextPrefix, section.path.length > 0 ? `Section path: ${section.path.join(' > ')}.` : '', chunkText]
          .filter(Boolean)
          .join('\n\n'),
      );
      records.push({
        chunkText,
        indexedText,
        chunkIndex: nextChunkIndex,
        sectionPath: section.path,
        parentSectionId: input.plan.hierarchical ? section.id : undefined,
        parentSectionText: input.plan.hierarchical ? parentSectionText : undefined,
        contextPrefix,
      });
      nextChunkIndex += 1;
    }
  }

  return records;
};

export const buildIndexedFileChunks = (input: {
  companyId: string;
  fileAssetId: string;
  fileName: string;
  mimeType: string;
  sourceUrl: string;
  uploaderUserId: string;
  visibility?: VectorUpsertDTO['visibility'];
  allowedRoles?: string[];
  text: string;
  metadata?: Record<string, unknown>;
}): CanonicalRetrievalChunk[] => {
  const title = input.fileName;
  const documentKey = `${input.companyId}:file_document:${input.fileAssetId}`;
  const sourceUpdatedAt = new Date().toISOString();
  const plan = chooseFileChunkingPlan({
    fileName: input.fileName,
    mimeType: input.mimeType,
    text: input.text,
  });
  const chunkRecords = buildChunkRecords({
    text: input.text,
    title,
    mimeType: input.mimeType,
    plan,
  });

  if (chunkRecords.length === 0) {
    return [];
  }

  return chunkRecords.map((record) => ({
    id: stableHash(`${input.companyId}|file_document|${input.fileAssetId}|${record.chunkIndex}|${record.indexedText}`),
    sourceType: 'file_document',
    sourceId: input.fileAssetId,
    chunkIndex: record.chunkIndex,
    documentKey,
    title,
    chunkText: record.indexedText,
    chunkTokenCount: estimateTokenCount(record.indexedText),
    sectionPath: record.sectionPath,
    sourceUpdatedAt,
    visibility: input.visibility ?? 'shared',
    allowedRoles: input.allowedRoles,
    ownerUserId: input.uploaderUserId,
    fileAssetId: input.fileAssetId,
    retrievalProfile: 'file',
    embeddingSchemaVersion: ACTIVE_EMBEDDING_SCHEMA_VERSION,
    payload: {
      citationType: 'file',
      citationTitle: title,
      fileName: input.fileName,
      mimeType: input.mimeType,
      cloudinaryUrl: input.sourceUrl,
      sourceUrl: input.sourceUrl,
      fileAssetId: input.fileAssetId,
      documentKey,
      allowedRoles: input.allowedRoles ?? [],
      title,
      chunkText: record.indexedText,
      text: record.indexedText,
      _chunk: record.chunkText,
      rawChunkText: record.chunkText,
      indexedChunkText: record.indexedText,
      parentSectionId: record.parentSectionId,
      parentSectionText: record.parentSectionText,
      sectionPath: record.sectionPath ?? [],
      contextPrefix: record.contextPrefix,
      documentClass: plan.documentClass,
      chunkingStrategy: plan.strategy,
      hierarchical: plan.hierarchical,
      contextualEnrichmentApplied: Boolean(record.contextPrefix),
      modality: input.mimeType.startsWith('image/')
        ? 'image'
        : input.mimeType.startsWith('video/')
          ? 'video'
          : 'text',
      embeddingSchemaVersion: ACTIVE_EMBEDDING_SCHEMA_VERSION,
      retrievalProfile: 'file',
      sourceUpdatedAt,
      ...(input.metadata ?? {}),
    },
  }));
};

