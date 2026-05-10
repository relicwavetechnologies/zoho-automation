import type {
  AttachmentPolicyViolation,
  AttachmentRef,
  AttachmentResolveContext,
  AttachmentSource,
  AttachmentSourceAdapter,
  ResolvedAttachment,
} from './attachment.types';
import { MAX_ATTACHMENT_COUNT, sanitizeFilename, validateAttachmentPolicy } from './attachment-policy';
import type { Result } from '../../shared/result';
import { err, ok } from '../../shared/result';

export class AttachmentResolverService {
  constructor(
    private readonly adapters: ReadonlyMap<AttachmentSource, AttachmentSourceAdapter>,
  ) {}

  async resolve(
    refs: readonly AttachmentRef[],
    ctx: AttachmentResolveContext,
  ): Promise<Result<ResolvedAttachment[], AttachmentPolicyViolation>> {
    if (refs.length > MAX_ATTACHMENT_COUNT) {
      return err({
        code: 'too_many_files',
        message: `Maximum ${MAX_ATTACHMENT_COUNT} attachments per email.`,
      });
    }

    const resolved: ResolvedAttachment[] = [];
    for (const ref of refs) {
      const adapter = this.adapters.get(ref.source);
      if (!adapter) {
        return err({
          code: 'source_disabled',
          message: `Attachment source "${ref.source}" is not enabled.`,
        });
      }

      try {
        const attachment = await adapter.resolve(ref, ctx);
        resolved.push({
          ...attachment,
          fileName: sanitizeFilename(attachment.fileName),
          sizeBytes: attachment.content.length,
        });
      } catch (error) {
        return err({
          code: 'source_disabled',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const policy = validateAttachmentPolicy(resolved);
    if (!policy.ok) return policy;
    return ok(resolved);
  }
}
