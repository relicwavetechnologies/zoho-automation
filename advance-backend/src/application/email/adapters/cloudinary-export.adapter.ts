import type { CloudinaryAdapter, CloudinaryResourceType } from '../../../infrastructure/cloudinary/cloudinary.adapter';
import type {
  AttachmentRef,
  AttachmentResolveContext,
  AttachmentSourceAdapter,
  ResolvedAttachment,
} from '../attachment.types';
import { extname } from 'node:path';

const MIME_BY_EXT: Record<string, string> = {
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export class CloudinaryExportAttachmentAdapter implements AttachmentSourceAdapter {
  readonly source = 'cloudinary' as const;

  constructor(
    private readonly cloudinaryAdapter: CloudinaryAdapter,
  ) {}

  async resolve(ref: AttachmentRef, _ctx: AttachmentResolveContext): Promise<ResolvedAttachment> {
    if (ref.source !== 'cloudinary') {
      throw new Error('CloudinaryExportAttachmentAdapter received an incompatible attachment ref');
    }

    const resourceType = (ref.resourceType ?? 'raw') as CloudinaryResourceType;
    const signedUrl = this.cloudinaryAdapter.getSignedDownloadUrl(ref.publicId, resourceType);

    const response = await fetch(signedUrl);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Cloudinary download failed: ${response.status} ${body.slice(0, 200)}`);
    }

    const content = Buffer.from(await response.arrayBuffer());
    const fileName = ref.fileName ?? filenameFromPublicId(ref.publicId);
    const ext = extname(fileName).toLowerCase();
    const mimeType = MIME_BY_EXT[ext] ?? 'application/octet-stream';

    return {
      fileName,
      mimeType,
      sizeBytes: content.length,
      content,
      source: this.source,
    };
  }
}

function filenameFromPublicId(publicId: string): string {
  const last = publicId.split('/').pop() ?? 'export';
  return last.includes('.') ? last : `${last}.csv`;
}
