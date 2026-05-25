import type { CloudinaryAdapter, CloudinaryResourceType } from '../../../infrastructure/cloudinary/cloudinary.adapter';
import type { FileAssetRepository } from '../../../infrastructure/persistence/file-asset.repository';
import type {
  AttachmentRef,
  AttachmentResolveContext,
  AttachmentSourceAdapter,
  ResolvedAttachment,
} from '../attachment.types';

export class FileAssetAttachmentAdapter implements AttachmentSourceAdapter {
  readonly source = 'file_asset' as const;

  constructor(
    private readonly fileAssetRepo: FileAssetRepository,
    private readonly cloudinaryAdapter: CloudinaryAdapter,
  ) {}

  async resolve(ref: AttachmentRef, ctx: AttachmentResolveContext): Promise<ResolvedAttachment> {
    if (ref.source !== 'file_asset') {
      throw new Error('FileAssetAttachmentAdapter received an incompatible attachment ref');
    }

    const found = await this.fileAssetRepo.findById(ref.fileAssetId);
    if (!found.ok) throw found.error;
    if (!found.value || found.value.companyId !== ctx.companyId) {
      throw new Error('File asset attachment not found');
    }

    const signedUrl = this.cloudinaryAdapter.getSignedDownloadUrl(
      found.value.cloudinaryPublicId,
      found.value.cloudinaryResourceType as CloudinaryResourceType,
    );
    const response = await fetch(signedUrl);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`File asset download failed: ${response.status} ${body.slice(0, 200)}`);
    }

    const content = Buffer.from(await response.arrayBuffer());
    return {
      fileName: found.value.fileName,
      mimeType: found.value.mimeType,
      sizeBytes: content.length,
      content,
      source: this.source,
    };
  }
}
