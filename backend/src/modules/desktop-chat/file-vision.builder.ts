import { prisma } from '../../utils/prisma';
import { qdrantAdapter } from '../../company/integrations/vector/qdrant.adapter';
import { embeddingService } from '../../company/integrations/embedding';
import { logger } from '../../utils/logger';
import { extractTextFromBuffer, normalizeExtractedText } from '../file-upload/document-text-extractor';
import { vectorDocumentRepository } from '../../company/integrations/vector/vector-document.repository';
import { orangeDebug } from '../../utils/orange-debug';

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

const VIDEO_MIME_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime',
]);

const fetchIndexedFileChunks = async (input: {
  fileAssetId: string;
  companyId: string;
  maxChars?: number;
}): Promise<string> => {
  try {
    const documents = await vectorDocumentRepository.findByFileAsset({
      companyId: input.companyId,
      fileAssetId: input.fileAssetId,
    });
    if (documents.length === 0) return '';

    const combined = documents
      .map((doc) => {
        const payload = (doc.payload ?? {}) as Record<string, unknown>;
        if (typeof payload._chunk === 'string') return payload._chunk;
        if (typeof payload.text === 'string') return payload.text;
        return '';
      })
      .filter(Boolean)
      .join('\n\n');

    const maxChars = input.maxChars ?? 18000;
    return combined.length > maxChars ? `${combined.slice(0, maxChars)}\n...[document truncated]` : combined;
  } catch (err) {
    logger.warn('file.vision.indexed_chunks.fetch.failed', {
      fileAssetId: input.fileAssetId,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return '';
  }
};

/**
 * Semantic retrieval fallback for documents when the file has already been
 * indexed but we want a query-shaped subset instead of the full chunk list.
 */
const fetchRelevantDocumentChunks = async (input: {
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
    logger.warn('file.vision.semantic_chunks.fetch.failed', {
      fileAssetId: input.fileAssetId,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return '';
  }
};

const fetchDirectDocumentText = async (input: {
  fileAssetId: string;
  fileName: string;
  mimeType: string;
  cloudinaryUrl: string;
}): Promise<string> => {
  try {
    const response = await fetch(input.cloudinaryUrl);
    if (!response.ok) {
      logger.warn('file.vision.direct_fetch.failed', {
        fileAssetId: input.fileAssetId,
        status: response.status,
      });
      return '';
    }

    const arrayBuffer = await response.arrayBuffer();
    const rawText = await extractTextFromBuffer(Buffer.from(arrayBuffer), input.mimeType, input.fileName);
    return normalizeExtractedText(rawText);
  } catch (err) {
    logger.warn('file.vision.direct_fetch.error', {
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
  requesterUserId?: string;
  requesterAiRole?: string;
}): Promise<VisionMessageContent[]> => {
  const parts: VisionMessageContent[] = [];

  // Always put the user's text first
  parts.push({ type: 'text', text: input.userMessage });

  const hasDocumentAttachments = input.attachedFiles.some((file) => !IMAGE_MIME_TYPES.has(file.mimeType));
  if (hasDocumentAttachments) {
    parts.push({
      type: 'text',
      text: 'One or more attached documents have already been extracted below. Use that document content directly. Do not say that you cannot access or read the attached file unless the extracted content block explicitly says it is unavailable.',
    });
  }

  for (const file of input.attachedFiles) {
    const asset = await prisma.fileAsset.findFirst({
      where: {
        id: file.fileAssetId,
        companyId: input.companyId,
      },
      select: {
        uploaderUserId: true,
      },
    });

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
    const isOwner = !!input.requesterUserId && asset?.uploaderUserId === input.requesterUserId;
    const hasAccess = policy !== null || isSuperRole || isOwner;
    orangeDebug('file.vision.access.check', {
      fileAssetId: file.fileAssetId,
      requesterUserId: input.requesterUserId ?? null,
      requesterAiRole: input.requesterAiRole ?? null,
      isOwner,
      hasRolePolicy: policy !== null,
      isSuperRole,
      hasAccess,
      mimeType: file.mimeType,
    });

    if (!hasAccess) {
      logger.warn('file.vision.rbac.denied', {
        fileAssetId: file.fileAssetId,
        requesterUserId: input.requesterUserId,
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
      orangeDebug('file.vision.image.part', {
        fileAssetId: file.fileAssetId,
        fileName: file.fileName,
        mimeType: file.mimeType,
      });
      parts.push({
        type: 'image',
        image: file.cloudinaryUrl,
        mimeType: file.mimeType,
      });
    } else {
      const blockLabel = VIDEO_MIME_TYPES.has(file.mimeType)
        ? `Attached media summary from "${file.fileName}"`
        : `Attached document content from "${file.fileName}"`;
      const excerptLabel = VIDEO_MIME_TYPES.has(file.mimeType)
        ? `Relevant media excerpts from "${file.fileName}"`
        : `Relevant document excerpts from "${file.fileName}"`;
      const fullIndexedContext = await fetchIndexedFileChunks({
        fileAssetId: file.fileAssetId,
        companyId: input.companyId,
      });

      if (fullIndexedContext) {
        parts.push({
          type: 'text',
          text: `\n\n--- ${blockLabel} ---\n${fullIndexedContext}\n--- End ${blockLabel} ---`,
        });
      } else {
        const relevantContext = await fetchRelevantDocumentChunks({
          fileAssetId: file.fileAssetId,
          companyId: input.companyId,
          requesterAiRole: input.requesterAiRole,
          queryText: input.userMessage,
        });

        if (relevantContext) {
          parts.push({
            type: 'text',
            text: `\n\n--- ${excerptLabel} ---\n${relevantContext}\n--- End ${excerptLabel} ---`,
          });
          continue;
        }

        const directText = VIDEO_MIME_TYPES.has(file.mimeType)
          ? ''
          : await fetchDirectDocumentText({
            fileAssetId: file.fileAssetId,
            fileName: file.fileName,
            mimeType: file.mimeType,
            cloudinaryUrl: file.cloudinaryUrl,
          });

        if (directText) {
          parts.push({
            type: 'text',
            text: `\n\n--- Direct document content from "${file.fileName}" ---\n${directText}\n--- End direct document content ---`,
          });
          continue;
        }

        parts.push({
          type: 'text',
          text: `[Document "${file.fileName}" is being processed or has no accessible content.]`,
        });
      }
    }
  }

  return parts;
};
