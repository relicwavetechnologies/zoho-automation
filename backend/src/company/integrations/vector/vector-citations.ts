import type { VectorSearchResult } from './vector-store.adapter';

export type CitationRef = {
  id: string;
  kind: 'file' | 'record';
  title: string;
  url?: string;
  sourceType: string;
  sourceId: string;
  fileAssetId?: string;
  chunkIndex?: number;
  score?: number;
};

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

export const buildCitationFromVectorResult = (
  match: VectorSearchResult,
  index = 0,
): CitationRef | null => {
  const payload = match.payload ?? {};
  const sourceUrl =
    readString(payload.sourceUrl)
    ?? readString(payload.cloudinaryUrl)
    ?? readString(payload.url)
    ?? readString(payload.recordUrl);
  const title =
    readString(payload.citationTitle)
    ?? readString(payload.fileName)
    ?? readString(payload.title)
    ?? readString(payload.name)
    ?? `${match.sourceType}:${match.sourceId}`;

  if (!sourceUrl && !title) {
    return null;
  }

  return {
    id: `${match.sourceType}:${match.sourceId}:${match.chunkIndex}:${index}`,
    kind: match.sourceType === 'file_document' ? 'file' : 'record',
    title,
    url: sourceUrl,
    sourceType: match.sourceType,
    sourceId: match.sourceId,
    fileAssetId: readString(payload.fileAssetId),
    chunkIndex: match.chunkIndex,
    score: match.score,
  };
};
