import { conversationMemoryStore } from '../../../../state/conversation';
import type { VercelRuntimeRequestContext } from '../../types';

export type RuntimeFileReference = {
  fileAssetId: string;
  fileName: string;
  mimeType?: string;
  cloudinaryUrl?: string;
  ingestionStatus?: string;
  updatedAtMs: number;
};

const FILE_LOOKUP_STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  'file',
  'files',
  'doc',
  'docs',
  'document',
  'documents',
  'pdf',
  'uploaded',
  'upload',
  'shared',
  'above',
  'latest',
  'recent',
]);

const normalizeFileLookupText = (value?: string): string =>
  (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokenizeFileLookupText = (value?: string): string[] =>
  normalizeFileLookupText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !FILE_LOOKUP_STOP_WORDS.has(token));

const scoreRuntimeFileMatch = (file: RuntimeFileReference, query: string): number => {
  const normalizedQuery = normalizeFileLookupText(query);
  const normalizedName = normalizeFileLookupText(file.fileName);
  if (!normalizedQuery || !normalizedName) {
    return 0;
  }
  if (normalizedName === normalizedQuery) {
    return 1;
  }
  if (normalizedName.includes(normalizedQuery)) {
    return 0.95;
  }
  if (normalizedQuery.includes(normalizedName)) {
    return 0.9;
  }

  const queryTokens = tokenizeFileLookupText(query);
  const nameTokens = tokenizeFileLookupText(file.fileName);
  if (queryTokens.length === 0 || nameTokens.length === 0) {
    return 0;
  }

  const exactMatches = queryTokens.filter((token) => nameTokens.includes(token)).length;
  const partialMatches = queryTokens.filter((token) =>
    nameTokens.some((nameToken) => nameToken.includes(token) || token.includes(nameToken)),
  ).length;

  const exactScore = exactMatches / queryTokens.length;
  const partialScore = partialMatches / queryTokens.length;
  const recencyBoost = Math.min(
    0.05,
    Math.max(
      0,
      (file.updatedAtMs - Date.now() + 7 * 24 * 60 * 60 * 1000) / (7 * 24 * 60 * 60 * 1000),
    ) * 0.05,
  );
  return Math.max(exactScore * 0.8 + partialScore * 0.15 + recencyBoost, 0);
};

const resolveFuzzyRuntimeFileMatch = (
  files: RuntimeFileReference[],
  query: string,
): RuntimeFileReference | null => {
  const ranked = files
    .map((file) => ({ file, score: scoreRuntimeFileMatch(file, query) }))
    .filter((entry) => entry.score >= 0.45)
    .sort(
      (left, right) => right.score - left.score || right.file.updatedAtMs - left.file.updatedAtMs,
    );
  return ranked[0]?.file ?? null;
};

export const rankRuntimeFileMatches = (
  files: RuntimeFileReference[],
  query?: string,
): RuntimeFileReference[] => {
  const normalizedQuery = query?.trim();
  if (!normalizedQuery) {
    return files.slice().sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  }
  return files
    .map((file) => ({ file, score: scoreRuntimeFileMatch(file, normalizedQuery) }))
    .filter((entry) => entry.score >= 0.2)
    .sort(
      (left, right) => right.score - left.score || right.file.updatedAtMs - left.file.updatedAtMs,
    )
    .map((entry) => entry.file);
};

const buildRuntimeFileRecord = (
  entry: Record<string, unknown>,
  asString: (value: unknown) => string | undefined,
): RuntimeFileReference => ({
  fileAssetId: asString(entry.id) ?? '',
  fileName: asString(entry.fileName) ?? 'file',
  mimeType: asString(entry.mimeType),
  cloudinaryUrl: asString(entry.cloudinaryUrl),
  ingestionStatus: asString(entry.ingestionStatus),
  updatedAtMs:
    Date.parse(asString(entry.updatedAt) ?? asString(entry.createdAt) ?? '') || Date.now(),
});

export const listVisibleRuntimeFiles = async (
  runtime: VercelRuntimeRequestContext,
  deps: {
    loadFileUploadService: () => {
      listVisibleFiles: (input: Record<string, unknown>) => Promise<Array<unknown>>;
    };
    asRecord: (value: unknown) => Record<string, unknown> | null;
    asString: (value: unknown) => string | undefined;
  },
): Promise<RuntimeFileReference[]> => {
  const files = await deps.loadFileUploadService().listVisibleFiles({
    companyId: runtime.companyId,
    requesterUserId: runtime.userId,
    requesterChannelIdentityId: runtime.requesterChannelIdentityId,
    requesterAiRole: runtime.requesterAiRole,
    requesterEmail: runtime.requesterEmail,
    isAdmin:
      runtime.requesterAiRole === 'COMPANY_ADMIN' || runtime.requesterAiRole === 'SUPER_ADMIN',
  });

  return files
    .map((entry) => deps.asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => buildRuntimeFileRecord(entry, deps.asString))
    .filter((entry) => Boolean(entry.fileAssetId));
};

export const resolveRuntimeFile = async (
  runtime: VercelRuntimeRequestContext,
  input: { fileAssetId?: string; fileName?: string },
  deps: {
    listVisibleRuntimeFiles: (runtime: VercelRuntimeRequestContext) => Promise<RuntimeFileReference[]>;
    buildConversationKey: (threadId: string) => string;
  },
): Promise<RuntimeFileReference | null> => {
  const runtimeAttachments = Array.isArray(runtime.attachedFiles) ? runtime.attachedFiles : [];
  const attachmentMatches = runtimeAttachments
    .filter((file) => file.fileAssetId && file.fileName)
    .map((file) => ({
      fileAssetId: file.fileAssetId,
      fileName: file.fileName,
      mimeType: file.mimeType,
      cloudinaryUrl: file.cloudinaryUrl,
    }));
  const files = await deps.listVisibleRuntimeFiles(runtime);
  const mergedFiles = [
    ...attachmentMatches,
    ...files.filter(
      (file) =>
        !attachmentMatches.some((attachment) => attachment.fileAssetId === file.fileAssetId),
    ),
  ];
  const normalizedId = input.fileAssetId?.trim();
  if (normalizedId) {
    return mergedFiles.find((file) => file.fileAssetId === normalizedId) ?? null;
  }

  const normalizedName = input.fileName?.trim().toLowerCase();
  if (normalizedName) {
    return (
      mergedFiles.find((file) => file.fileName.trim().toLowerCase() === normalizedName) ??
      mergedFiles.find((file) => file.fileName.trim().toLowerCase().includes(normalizedName)) ??
      resolveFuzzyRuntimeFileMatch(mergedFiles, normalizedName) ??
      null
    );
  }

  const latest = conversationMemoryStore.getLatestFileAsset(deps.buildConversationKey(runtime.threadId));
  if (!latest) {
    return null;
  }
  return mergedFiles.find((file) => file.fileAssetId === latest.fileAssetId) ?? latest;
};

export const extractFileText = async (
  runtime: VercelRuntimeRequestContext,
  file: RuntimeFileReference,
  deps: {
    loadFileRetrievalService: () => {
      getIndexedFileText: (input: Record<string, unknown>) => Promise<string>;
    };
    loadDocumentTextHelpers: () => {
      extractTextFromBuffer: (
        buffer: Buffer,
        mimeType: string,
        fileName: string,
      ) => Promise<string>;
      normalizeExtractedText: (text: string) => string;
    };
  },
): Promise<{ text: string; source: 'vector' | 'ocr' }> => {
  const indexedText = await deps.loadFileRetrievalService().getIndexedFileText({
    companyId: runtime.companyId,
    fileAssetId: file.fileAssetId,
    maxChars: 18_000,
  });
  if (indexedText) {
    return { text: indexedText, source: 'vector' };
  }

  if (!file.cloudinaryUrl || !file.mimeType) {
    return { text: '', source: 'ocr' };
  }

  const response = await fetch(file.cloudinaryUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch file content for OCR: ${response.status} ${response.statusText}`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  const { extractTextFromBuffer, normalizeExtractedText } = deps.loadDocumentTextHelpers();
  const rawText = await extractTextFromBuffer(
    Buffer.from(arrayBuffer),
    file.mimeType,
    file.fileName,
  );
  return {
    text: normalizeExtractedText(rawText),
    source: 'ocr',
  };
};
