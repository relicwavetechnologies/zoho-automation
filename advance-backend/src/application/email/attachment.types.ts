import type { Result } from '../../shared/result';

export type AttachmentSource =
  | 'outbound_artifact'
  | 'google_drive'
  | 'lark'
  | 'cloudinary';

export type AttachmentRef =
  | { readonly source: 'outbound_artifact'; readonly artifactId: string }
  | { readonly source: 'google_drive'; readonly connectionId: string; readonly fileId: string; readonly exportMimeType?: string }
  | { readonly source: 'lark'; readonly messageId: string; readonly fileKey: string; readonly fileName?: string }
  | { readonly source: 'cloudinary'; readonly publicId: string; readonly fileName?: string; readonly resourceType?: string };

export interface ResolvedAttachment {
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly content: Buffer;
  readonly source: AttachmentSource;
}

export type AttachmentPolicyViolationCode =
  | 'too_many_files'
  | 'file_too_large'
  | 'aggregate_too_large'
  | 'blocked_extension'
  | 'source_disabled';

export interface AttachmentPolicyViolation {
  readonly code: AttachmentPolicyViolationCode;
  readonly message: string;
}

export interface AttachmentResolveContext {
  readonly companyId: string;
  readonly userId: string;
}

export interface AttachmentSourceAdapter {
  readonly source: AttachmentSource;
  resolve(ref: AttachmentRef, ctx: AttachmentResolveContext): Promise<ResolvedAttachment>;
}

export type ResolveAttachments = (
  refs: readonly AttachmentRef[],
  ctx: AttachmentResolveContext,
) => Promise<Result<ResolvedAttachment[], AttachmentPolicyViolation>>;
