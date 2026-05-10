import type { PrismaClient } from '../../../generated/prisma';
import type {
  AttachmentRef,
  AttachmentResolveContext,
  AttachmentSourceAdapter,
  ResolvedAttachment,
} from '../attachment.types';

export class OutboundArtifactAttachmentAdapter implements AttachmentSourceAdapter {
  readonly source = 'outbound_artifact' as const;

  constructor(private readonly prisma: PrismaClient) {}

  async resolve(ref: AttachmentRef, ctx: AttachmentResolveContext): Promise<ResolvedAttachment> {
    if (ref.source !== 'outbound_artifact') {
      throw new Error('OutboundArtifactAttachmentAdapter received an incompatible attachment ref');
    }

    const row = await this.prisma.outboundArtifact.findFirst({
      where: { id: ref.artifactId, companyId: ctx.companyId },
      select: {
        fileName: true,
        mimeType: true,
        contentBase64: true,
      },
    });
    if (!row) throw new Error('Outbound artifact attachment not found');

    const content = Buffer.from(row.contentBase64, 'base64');
    return {
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: content.length,
      content,
      source: this.source,
    };
  }
}
