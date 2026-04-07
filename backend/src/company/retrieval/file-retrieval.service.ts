import { googleRankingService } from '../integrations/search';
import { embeddingService } from '../integrations/embedding';
import {
  qdrantAdapter,
  RETRIEVAL_PROFILE_CONFIG,
  vectorDocumentRepository,
} from '../integrations/vector';
import type { VectorDocument } from '../../generated/prisma';
import { retrievalFeatureFlags } from './retrieval-feature-flags';
import { buildCitationFromVectorResult, type CitationRef } from '../integrations/vector/vector-citations';
import {
  type DocumentSearchEnhancement,
  buildDocumentSearchQueries,
  broadenDocumentSearchQuery,
  determineDocumentSearchEnhancements,
} from './file-search-query';

export type DocumentSearchMatch = {
  id: string;
  fileName: string;
  text: string;
  displayText: string;
  modality: string;
  url?: string;
  score?: number;
  sourceId?: string;
  chunkIndex?: number;
  documentClass?: string;
  chunkingStrategy?: string;
  sectionPath?: string[];
  parentSectionId?: string;
  parentSectionText?: string;
};

export type DocumentSearchResult = {
  matches: DocumentSearchMatch[];
  citations: CitationRef[];
  enhancements: DocumentSearchEnhancement[];
  queriesUsed: string[];
  correctiveRetryUsed: boolean;
};

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry))
    : [];

const uniqueStrings = (values: string[]): string[] => Array.from(new Set(values.filter((value) => value.length > 0)));
const normalizeQuery = (value: string): string => value.trim().replace(/\s+/g, ' ');

const buildMatchId = (sourceType: string, sourceId: string | undefined, chunkIndex: number | undefined): string =>
  `${sourceType}:${sourceId ?? 'unknown'}:${chunkIndex ?? 0}`;

const payloadDisplayText = (payload: Record<string, unknown>, preferParentContext: boolean): string => {
  const raw =
    readString(payload._chunk)
    ?? readString(payload.rawChunkText)
    ?? readString(payload.chunkText)
    ?? readString(payload.text)
    ?? '';
  const parentSectionText = readString(payload.parentSectionText);
  if (preferParentContext && parentSectionText) {
    return parentSectionText;
  }
  return raw;
};

const documentTextFromStoredDocs = (docs: VectorDocument[], maxChars = 18_000): string => {
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const doc of docs) {
    const payload = (doc.payload ?? {}) as Record<string, unknown>;
    const parentSectionId = readString(payload.parentSectionId);
    const parentSectionText = readString(payload.parentSectionText);
    if (parentSectionId && parentSectionText && !seen.has(parentSectionId)) {
      seen.add(parentSectionId);
      parts.push(parentSectionText);
      continue;
    }

    const chunkText =
      readString(payload._chunk)
      ?? readString(payload.rawChunkText)
      ?? readString(payload.chunkText)
      ?? readString(payload.text);
    if (chunkText) {
      parts.push(chunkText);
    }
  }

  const joined = parts.join('\n\n').trim();
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n...[document truncated]` : joined;
};

export class FileRetrievalService {
  async search(input: {
    companyId: string;
    query: string;
    requesterAiRole?: string;
    requesterUserId?: string;
    fileAssetId?: string;
    limit?: number;
    preferParentContext?: boolean;
  }): Promise<DocumentSearchResult> {
    const normalizedQuery = normalizeQuery(input.query);
    if (!normalizedQuery) {
      return {
        matches: [],
        citations: [],
        enhancements: ['none'],
        queriesUsed: [],
        correctiveRetryUsed: false,
      };
    }

    const enhancements = determineDocumentSearchEnhancements(normalizedQuery);
    const searchQueries = buildDocumentSearchQueries(normalizedQuery);
    const profile = RETRIEVAL_PROFILE_CONFIG.file;
    const hitMap = new Map<string, Awaited<ReturnType<typeof qdrantAdapter.search>>[number]['hits'][number]>();

    const runSearch = async (queryText: string) => {
      const [queryVector] = await embeddingService.embedQueries([queryText]);
      const groups = await qdrantAdapter.search({
        companyId: input.companyId,
        denseVector: queryVector,
        lexicalQueryText: queryText,
        limit: Math.max(1, Math.min(profile.groupLimit, input.limit ?? profile.finalTopK)),
        candidateLimit: profile.branchLimit,
        retrievalProfile: 'file',
        fusion: 'dbsf',
        groupByField: 'documentKey',
        groupSize: profile.groupSize,
        sourceTypes: ['file_document'],
        fileAssetId: input.fileAssetId,
        includeShared: true,
        includePersonal: true,
        includePublic: false,
        requesterAiRole: input.requesterAiRole,
        requesterUserId: input.requesterUserId,
        useMultimodal: true,
        queryMode: 'text',
      });

      for (const hit of groups.flatMap((group) => group.hits)) {
        const key = buildMatchId(hit.sourceType, hit.sourceId, hit.chunkIndex);
        const existing = hitMap.get(key);
        if (!existing || existing.score < hit.score) {
          hitMap.set(key, hit);
        }
      }
    };

    for (const queryText of searchQueries) {
      await runSearch(queryText);
    }

    let correctiveRetryUsed = false;
    const maybeRetry = async () => {
      const broadened = broadenDocumentSearchQuery(normalizedQuery);
      if (!retrievalFeatureFlags.correctiveRetry || searchQueries.includes(broadened)) {
        return;
      }
      correctiveRetryUsed = true;
      await runSearch(broadened);
      searchQueries.push(broadened);
    };

    if (hitMap.size < Math.max(2, Math.min(4, input.limit ?? profile.finalTopK))) {
      await maybeRetry();
    }

    const hits = Array.from(hitMap.values());
    const rerankCandidates = hits.map((hit) => {
      const payload = hit.payload ?? {};
      return {
        id: buildMatchId(hit.sourceType, hit.sourceId, hit.chunkIndex),
        documentKey: hit.documentKey ?? `${input.companyId}:file_document:${hit.sourceId}`,
        chunkIndex: hit.chunkIndex,
        title: readString(payload.citationTitle) ?? readString(payload.fileName) ?? readString(payload.title),
        content: payloadDisplayText(payload, Boolean(input.preferParentContext)),
        score: hit.score,
        payload,
      };
    });

    const reranked = await googleRankingService.rerank(
      normalizedQuery,
      rerankCandidates,
      Math.min(profile.rerankTopN, rerankCandidates.length),
      { required: profile.rerankRequired },
    );
    const rerankedById = new Map(reranked.map((entry) => [entry.id, entry]));

    const matches = hits
      .filter((hit) => rerankedById.has(buildMatchId(hit.sourceType, hit.sourceId, hit.chunkIndex)))
      .sort((left, right) => {
        const leftScore =
          rerankedById.get(buildMatchId(left.sourceType, left.sourceId, left.chunkIndex))?.rerankScore
          ?? left.score;
        const rightScore =
          rerankedById.get(buildMatchId(right.sourceType, right.sourceId, right.chunkIndex))?.rerankScore
          ?? right.score;
        return rightScore - leftScore;
      })
      .slice(0, Math.max(1, Math.min(input.limit ?? profile.finalTopK, 10)))
      .map((hit) => {
        const payload = hit.payload ?? {};
        const score = rerankedById.get(buildMatchId(hit.sourceType, hit.sourceId, hit.chunkIndex))?.rerankScore ?? hit.score;
        return {
          id: buildMatchId(hit.sourceType, hit.sourceId, hit.chunkIndex),
          fileName: readString(payload.fileName) ?? readString(payload.title) ?? 'document',
          text: readString(payload._chunk) ?? readString(payload.rawChunkText) ?? readString(payload.text) ?? '',
          displayText: payloadDisplayText(payload, Boolean(input.preferParentContext)),
          modality: readString(payload.modality) ?? 'text',
          url: readString(payload.cloudinaryUrl) ?? readString(payload.sourceUrl),
          score,
          sourceId: hit.sourceId,
          chunkIndex: hit.chunkIndex,
          documentClass: readString(payload.documentClass),
          chunkingStrategy: readString(payload.chunkingStrategy),
          sectionPath: asStringArray(payload.sectionPath),
          parentSectionId: readString(payload.parentSectionId),
          parentSectionText: readString(payload.parentSectionText),
        } satisfies DocumentSearchMatch;
      });

    const citations = hits
      .map((hit, index) => buildCitationFromVectorResult(hit, index))
      .filter((entry): entry is CitationRef => entry !== null);

    return {
      matches,
      citations,
      enhancements,
      queriesUsed: uniqueStrings(searchQueries),
      correctiveRetryUsed,
    };
  }

  async readChunkContext(input: {
    companyId: string;
    fileAssetId: string;
    chunkIndex?: number;
  }): Promise<{ text: string; source: 'parent_section' | 'chunk' | 'document' | 'missing' }> {
    const docs = await vectorDocumentRepository.findByFileAsset({
      companyId: input.companyId,
      fileAssetId: input.fileAssetId,
    });
    if (docs.length === 0) {
      return { text: '', source: 'missing' };
    }

    const match = typeof input.chunkIndex === 'number'
      ? docs.find((doc) => doc.chunkIndex === input.chunkIndex)
      : docs[0];

    if (!match) {
      return { text: documentTextFromStoredDocs(docs), source: 'document' };
    }

    const payload = (match.payload ?? {}) as Record<string, unknown>;
    const parentSectionText = readString(payload.parentSectionText);
    if (parentSectionText) {
      return { text: parentSectionText, source: 'parent_section' };
    }

    const chunkText =
      readString(payload._chunk)
      ?? readString(payload.rawChunkText)
      ?? readString(payload.chunkText)
      ?? readString(payload.text)
      ?? '';
    if (chunkText) {
      return { text: chunkText, source: 'chunk' };
    }

    return { text: documentTextFromStoredDocs(docs), source: 'document' };
  }

  async getIndexedFileText(input: {
    companyId: string;
    fileAssetId: string;
    maxChars?: number;
  }): Promise<string> {
    const docs = await vectorDocumentRepository.findByFileAsset({
      companyId: input.companyId,
      fileAssetId: input.fileAssetId,
    });
    return documentTextFromStoredDocs(docs, input.maxChars);
  }
}

export const fileRetrievalService = new FileRetrievalService();
