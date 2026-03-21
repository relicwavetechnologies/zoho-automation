const ACCEPTED_EXTENSION_TO_MIME: Record<string, string> = {
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
}

const MIME_ALIASES: Record<string, string> = {
  'application/csv': 'text/csv',
  'application/x-csv': 'text/csv',
  'text/comma-separated-values': 'text/csv',
  'text/x-csv': 'text/csv',
}

const CSV_FILENAME_ONLY_ALIASES = new Set([
  'application/vnd.ms-excel',
])

const FILENAME_FALLBACK_MIME_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
])

const ACCEPTED_MIME_TYPES = new Set(Object.values(ACCEPTED_EXTENSION_TO_MIME))

const normalizeMimeType = (mimeType: string | undefined): string =>
  (mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''

const fileExtension = (fileName: string): string => {
  const match = /\.[^.]+$/.exec(fileName.trim().toLowerCase())
  return match?.[0] ?? ''
}

export const ACCEPTED_ATTACHMENT_INPUT = '.pdf,.docx,.doc,.txt,.md,.csv,.jpg,.jpeg,.png,.webp,.gif'

export function isAcceptedAttachmentFile(file: Pick<File, 'name' | 'type'>): boolean {
  const normalizedMimeType = normalizeMimeType(file.type)
  if (ACCEPTED_MIME_TYPES.has(normalizedMimeType)) {
    return true
  }

  if (MIME_ALIASES[normalizedMimeType]) {
    return true
  }

  const extension = fileExtension(file.name)
  const inferredMimeType = extension ? ACCEPTED_EXTENSION_TO_MIME[extension] : undefined
  if (!inferredMimeType) {
    return false
  }

  if (FILENAME_FALLBACK_MIME_TYPES.has(normalizedMimeType)) {
    return true
  }

  return inferredMimeType === 'text/csv' && CSV_FILENAME_ONLY_ALIASES.has(normalizedMimeType)
}
