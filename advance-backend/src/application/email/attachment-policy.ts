import type { Result } from '../../shared/result';
import { err, ok } from '../../shared/result';
import type { AttachmentPolicyViolation, ResolvedAttachment } from './attachment.types';

export const MAX_ATTACHMENT_COUNT = 10;
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_AGGREGATE_SIZE_BYTES = 18 * 1024 * 1024;

export const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.scr',
  '.pif',
  '.msi',
  '.com',
  '.vbs',
  '.js',
  '.ps1',
  '.sh',
  '.dmg',
  '.pkg',
  '.app',
  '.jar',
  '.docm',
  '.xlsm',
  '.pptm',
]);

export function validateAttachmentPolicy(
  resolved: readonly ResolvedAttachment[],
): Result<void, AttachmentPolicyViolation> {
  if (resolved.length > MAX_ATTACHMENT_COUNT) {
    return err({
      code: 'too_many_files',
      message: `Maximum ${MAX_ATTACHMENT_COUNT} attachments per email.`,
    });
  }

  let aggregate = 0;
  for (const attachment of resolved) {
    aggregate += attachment.sizeBytes;

    if (attachment.sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
      return err({
        code: 'file_too_large',
        message: `Attachment "${attachment.fileName}" exceeds the 10 MB limit.`,
      });
    }

    const extension = extensionOf(attachment.fileName);
    if (extension && BLOCKED_EXTENSIONS.has(extension)) {
      return err({
        code: 'blocked_extension',
        message: `Cannot attach executable or macro-enabled files: ${attachment.fileName}`,
      });
    }
  }

  if (aggregate > MAX_AGGREGATE_SIZE_BYTES) {
    return err({
      code: 'aggregate_too_large',
      message: 'Attachments exceed the 18 MB total limit.',
    });
  }

  return ok(undefined);
}

export function sanitizeFilename(raw: string): string {
  const cleaned = raw
    .replace(/[\0-\x1F\x7F]/g, '')
    .replace(/[\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .trim();
  return cleaned || 'attachment';
}

function extensionOf(fileName: string): string {
  const lastSegment = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0 || dot === lastSegment.length - 1) return '';
  return lastSegment.slice(dot).toLowerCase();
}
