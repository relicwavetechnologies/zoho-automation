import { extname } from 'path';

const SUPPORTED_MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

const MIME_ALIASES: Record<string, string> = {
  'application/csv': 'text/csv',
  'application/x-csv': 'text/csv',
  'text/comma-separated-values': 'text/csv',
  'text/x-csv': 'text/csv',
};

const CSV_FILENAME_ONLY_ALIASES = new Set([
  'application/vnd.ms-excel',
]);

const EXTENSION_PRIORITY_MIME_TYPES = new Set([
  'text/csv',
  'text/markdown',
]);

const FILENAME_FALLBACK_MIME_TYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
]);

export const SUPPORTED_UPLOAD_MIME_TYPES = new Set(
  Object.values(SUPPORTED_MIME_BY_EXTENSION),
);

export const normalizeMimeType = (mimeType?: string | null): string | undefined => {
  if (typeof mimeType !== 'string') return undefined;
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase();
  return normalized ? normalized : undefined;
};

export const inferSupportedMimeTypeFromFileName = (fileName?: string | null): string | undefined => {
  if (typeof fileName !== 'string') return undefined;
  const extension = extname(fileName).trim().toLowerCase();
  return extension ? SUPPORTED_MIME_BY_EXTENSION[extension] : undefined;
};

export const resolveSupportedUploadMimeType = (input: {
  mimeType?: string | null;
  fileName?: string | null;
}): string | undefined => {
  const normalizedMimeType = normalizeMimeType(input.mimeType);
  const inferredFromFileName = inferSupportedMimeTypeFromFileName(input.fileName);

  if (
    normalizedMimeType === 'text/plain'
    && inferredFromFileName
    && EXTENSION_PRIORITY_MIME_TYPES.has(inferredFromFileName)
  ) {
    return inferredFromFileName;
  }

  if (normalizedMimeType && SUPPORTED_UPLOAD_MIME_TYPES.has(normalizedMimeType)) {
    return normalizedMimeType;
  }

  if (normalizedMimeType && MIME_ALIASES[normalizedMimeType]) {
    return MIME_ALIASES[normalizedMimeType];
  }

  if (!inferredFromFileName) {
    return undefined;
  }

  if (!normalizedMimeType || FILENAME_FALLBACK_MIME_TYPES.has(normalizedMimeType)) {
    return inferredFromFileName;
  }

  if (
    inferredFromFileName === 'text/csv'
    && CSV_FILENAME_ONLY_ALIASES.has(normalizedMimeType)
  ) {
    return inferredFromFileName;
  }

  return undefined;
};
