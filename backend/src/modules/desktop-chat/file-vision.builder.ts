import { prisma } from '../../utils/prisma';
import { qdrantAdapter } from '../../company/integrations/vector/qdrant.adapter';
import { embeddingService } from '../../company/integrations/embedding';
import { logger } from '../../utils/logger';

/**
 * Represents an attached file context for the AI message.
 * Images are passed as vision URLs; documents are read from Qdrant vectors.
 */
export type AttachedFileRef = {
  fileAssetId: string;
  cloudinaryUrl: string;
  mimeType: string;
  fileName: string;
};

/**
 * AI-SDK / Mastra content part for vision (image URL).
 * Works identically for GPT-4o and Gemini via Vercel AI SDK.
 */
export type ImageContentPart = {
  type: 'image';
  image: string; // HTTPS URL or data URI
  mimeType?: string;
};

export type TextContentPart = {
  type: 'text';
  text: string;
};

export type VisionMessageContent = TextContentPart | ImageContentPart;

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

/**
 * Fetches RBAC-allowed vector chunks for a document file asset.
 * Re-runs semantic search over the file's chunks from Qdrant,
 * filtered by the requester's AI role.
 */
const fetchDocumentContext = async (input: {
  fileAssetId: string;
  companyId: string;
  requesterAiRole?: string;
  queryText: string;
}): Promise<string> => {
  try {
    const [queryVector] = await embeddingService.embed([input.queryText]);
    const results = await qdrantAdapter.search({
      companyId: input.companyId,
      vector: queryVector,
      limit: 5,
      sourceTypes: ['file_document'],
      includeShared: true,
      includePersonal: false,
      includePublic: false,
      requesterAiRole: input.requesterAiRole,
    });

    // Filter to only the specific fileAssetId
    const fileChunks = results.filter(
      (r) => typeof r.payload.fileAssetId === 'string' && r.payload.fileAssetId === input.fileAssetId,
    );
    if (fileChunks.length === 0) return '';

    return fileChunks
      .map((r) => {
        const text = typeof r.payload._chunk === 'string'
          ? r.payload._chunk
          : typeof r.payload.text === 'string'
            ? r.payload.text
            : '';
        return text;
      })
      .filter(Boolean)
      .join('\n\n');
  } catch (err) {
    logger.warn('file.vision.qdrant.fetch.failed', {
      fileAssetId: input.fileAssetId,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return '';
  }
};

/**
 * Builds Vercel AI SDK message content parts from attached file references.
 * - Images → ImageContentPart (vision URL, works for GPT-4o and Gemini)
 * - Documents → TextContentPart with extracted vector chunks
 *
 * RBAC is enforced:
 *  1. Checks FileAccessPolicy — user's role must be in allowedRoles
 *  2. Qdrant query also filters by allowedRoles at vector level
 */
export const buildVisionContent = async (input: {
  userMessage: string;
  attachedFiles: AttachedFileRef[];
  companyId: string;
  requesterAiRole?: string;
}): Promise<VisionMessageContent[]> => {
  const parts: VisionMessageContent[] = [];

  // Always put the user's text first
  parts.push({ type: 'text', text: input.userMessage });

  for (const file of input.attachedFiles) {
    // ── RBAC gate: verify the requester has access ────────────────────────────
    const policy = await prisma.fileAccessPolicy.findFirst({
      where: {
        fileAssetId: file.fileAssetId,
        companyId: input.companyId,
        aiRole: input.requesterAiRole ?? 'MEMBER',
        canRead: true,
      },
    });

    // Also allow if no policies exist (open file) or if requester is SUPER_ADMIN/COMPANY_ADMIN
    const isSuperRole = ['SUPER_ADMIN', 'COMPANY_ADMIN'].includes(input.requesterAiRole ?? '');
    const hasAccess = policy !== null || isSuperRole;

    if (!hasAccess) {
      logger.warn('file.vision.rbac.denied', {
        fileAssetId: file.fileAssetId,
        requesterAiRole: input.requesterAiRole,
      });
      parts.push({
        type: 'text',
        text: `[File "${file.fileName}" is not accessible with your current role.]`,
      });
      continue;
    }

    if (IMAGE_MIME_TYPES.has(file.mimeType)) {
      // Vision: pass the Cloudinary HTTPS URL directly
      // Vercel AI SDK automatically handles this for both GPT-4o and Gemini
      parts.push({
        type: 'image',
        image: file.cloudinaryUrl,
        mimeType: file.mimeType,
      });
    } else {
      // Document: fetch relevant vector chunks from Qdrant (RBAC-filtered)
      const docContext = await fetchDocumentContext({
        fileAssetId: file.fileAssetId,
        companyId: input.companyId,
        requesterAiRole: input.requesterAiRole,
        queryText: input.userMessage,
      });

      if (docContext) {
        parts.push({
          type: 'text',
          text: `\n\n--- Document context from "${file.fileName}" ---\n${docContext}\n--- End document context ---`,
        });
      } else {
        parts.push({
          type: 'text',
          text: `[Document "${file.fileName}" is being processed or has no accessible content.]`,
        });
      }
    }
  }

  return parts;
};
