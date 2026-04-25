/**
 * Full-document reader — reassembles all chunks for a file from Postgres,
 * falling back to Cloudinary re-extraction if Postgres rows are missing.
 *
 * Used by the "exact wording" retrieval path.
 */
import type { VectorDocumentRepository } from '../../infrastructure/persistence/vector-document.repository';
import type { Logger } from '../../shared/logger';

export interface FullDocReaderDeps {
  vectorDocRepo: VectorDocumentRepository;
  logger:        Logger;
  maxChars:      number; // soft cap e.g. 18_000
}

export interface FullDocResult {
  text:         string;
  fileName:     string;
  cloudinaryUrl: string;
  /** Truncated from N chars to maxChars, if applicable. */
  truncated:    boolean;
}

/** Load and reassemble the full text of a file from VectorDocument chunk rows. */
export async function readFullDocFromVectorStore(
  fileAssetId: string,
  deps: FullDocReaderDeps,
): Promise<FullDocResult | null> {
  const result = await deps.vectorDocRepo.findByFileAsset(fileAssetId);
  if (!result.ok || result.value.length === 0) {
    deps.logger.warn('full_doc_reader.no_chunks', { fileAssetId });
    return null;
  }

  const rows = result.value;
  // Deduplicate by parentSectionId so parent-section context isn't repeated
  const seenParents = new Set<string>();
  const parts: string[] = [];

  for (const row of rows) {
    const payload = row.payload as Record<string, unknown>;
    const parentId  = (payload['parentSectionId'] as string | undefined) ?? null;
    const chunkText = (payload['rawChunkText'] ?? payload['chunkText'] ?? row.chunkText ?? '') as string;

    if (parentId && seenParents.has(parentId)) continue;
    if (parentId) seenParents.add(parentId);
    if (chunkText) parts.push(chunkText);
  }

  const fullText = parts.join('\n\n');
  const truncated = fullText.length > deps.maxChars;
  const text = truncated ? fullText.slice(0, deps.maxChars) : fullText;

  const firstPayload = rows[0]?.payload as Record<string, unknown>;
  return {
    text,
    truncated,
    fileName:     (firstPayload['fileName'] as string | undefined) ?? 'document',
    cloudinaryUrl: (firstPayload['cloudinaryUrl'] as string | undefined) ?? '',
  };
}

/** Fallback: fetch the file from Cloudinary URL and re-extract text. */
export async function readFullDocFromCloudinary(
  cloudinaryUrl: string,
  fileName: string,
  mimeType: string,
  openaiApiKey: string,
  maxChars: number,
  logger: Logger,
): Promise<string> {
  try {
    logger.info('full_doc_reader.cloudinary_fallback', { fileName, cloudinaryUrl });
    const { extractFromBuffer } = await import('../ingestion/text-extraction/extract');
    const response = await fetch(cloudinaryUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buf = Buffer.from(await response.arrayBuffer());
    const extracted = await extractFromBuffer(buf, mimeType, openaiApiKey, Math.ceil(maxChars / 5));
    return extracted.text.slice(0, maxChars);
  } catch (e) {
    logger.error('full_doc_reader.cloudinary_failed', { error: String(e) });
    return '';
  }
}
