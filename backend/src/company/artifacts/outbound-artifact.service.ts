import { Buffer } from 'buffer';

import { prisma } from '../../utils/prisma';
import { fileUploadService } from '../../modules/file-upload/file-upload.service';
import { zohoBooksClient } from '../integrations/zoho/zoho-books.client';
import { zohoGatewayService } from '../integrations/zoho/zoho-gateway.service';

type CreateArtifactInput = {
  companyId: string;
  createdByUserId?: string;
  sourceSystem: string;
  sourceKind: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
  sourceMetadata?: Record<string, unknown>;
  fileAssetId?: string;
  fileName: string;
  mimeType: string;
  contentBase64: string;
  sizeBytes?: number;
};

type ArtifactAccessInput = {
  artifactId: string;
  companyId: string;
  requesterUserId: string;
  requesterAiRole?: string;
};

type MaterializeFromUploadedFileInput = {
  companyId: string;
  requesterUserId: string;
  requesterAiRole: string;
  fileAssetId: string;
};

type MaterializeFromZohoBooksDocumentInput = {
  companyId: string;
  requesterUserId?: string;
  requesterAiRole?: string;
  requesterEmail?: string;
  organizationId?: string;
  moduleName: 'invoices' | 'estimates' | 'creditnotes' | 'bills' | 'salesorders' | 'purchaseorders';
  recordId: string;
  kind: 'record_document' | 'attachment';
  accept?: 'pdf' | 'html';
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const isAdminRole = (value?: string): boolean =>
  value === 'COMPANY_ADMIN' || value === 'SUPER_ADMIN';

const inferFileNameFromDisposition = (
  contentDisposition: string | undefined,
  fallback: string,
): string => {
  const value = contentDisposition?.trim();
  if (!value) {
    return fallback;
  }
  const starMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (starMatch?.[1]) {
    try {
      return decodeURIComponent(starMatch[1]).trim() || fallback;
    } catch {
      return starMatch[1].trim() || fallback;
    }
  }
  const match = value.match(/filename="?([^";]+)"?/i);
  return match?.[1]?.trim() || fallback;
};

const contentLengthFromBase64 = (contentBase64: string): number =>
  Buffer.byteLength(Buffer.from(contentBase64, 'base64'));

export class OutboundArtifactService {
  async createArtifact(input: CreateArtifactInput) {
    const normalizedContent = input.contentBase64.trim();
    const sizeBytes = input.sizeBytes ?? contentLengthFromBase64(normalizedContent);
    return prisma.outboundArtifact.create({
      data: {
        companyId: input.companyId,
        createdByUserId: input.createdByUserId?.trim() || null,
        sourceSystem: input.sourceSystem,
        sourceKind: input.sourceKind,
        sourceRecordType: input.sourceRecordType?.trim() || null,
        sourceRecordId: input.sourceRecordId?.trim() || null,
        sourceMetadata: input.sourceMetadata ?? undefined,
        fileAssetId: input.fileAssetId?.trim() || null,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes,
        contentBase64: normalizedContent,
      },
    });
  }

  async getArtifactForSend(input: ArtifactAccessInput) {
    const artifact = await prisma.outboundArtifact.findFirst({
      where: {
        id: input.artifactId,
        companyId: input.companyId,
      },
      include: {
        fileAsset: {
          include: {
            accessPolicies: true,
          },
        },
      },
    });
    if (!artifact) {
      throw new Error(`Attachment artifact ${input.artifactId} was not found.`);
    }

    const admin = isAdminRole(input.requesterAiRole);
    if (!admin && artifact.createdByUserId && artifact.createdByUserId !== input.requesterUserId) {
      throw new Error(`You are not allowed to use attachment artifact ${input.artifactId}.`);
    }

    if (!admin && artifact.fileAsset) {
      const canReadFile =
        artifact.fileAsset.uploaderUserId === input.requesterUserId
        || artifact.fileAsset.accessPolicies.some(
          (policy) => policy.canRead && policy.aiRole === input.requesterAiRole,
        );
      if (!canReadFile) {
        throw new Error(`You are not allowed to use attachment artifact ${input.artifactId}.`);
      }
    }

    return artifact;
  }

  async materializeFromUploadedFile(input: MaterializeFromUploadedFileInput) {
    const visibleFiles = await fileUploadService.listVisibleFiles({
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      requesterAiRole: input.requesterAiRole,
      isAdmin: isAdminRole(input.requesterAiRole),
    });
    const file = visibleFiles.find((entry) => entry.id === input.fileAssetId);
    if (!file?.cloudinaryUrl || !file.fileName || !file.mimeType) {
      throw new Error(`Uploaded file ${input.fileAssetId} is not accessible.`);
    }
    const response = await fetch(file.cloudinaryUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch uploaded file bytes: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const contentBase64 = Buffer.from(arrayBuffer).toString('base64');

    return this.createArtifact({
      companyId: input.companyId,
      createdByUserId: input.requesterUserId,
      sourceSystem: 'uploaded_file',
      sourceKind: 'file_asset',
      sourceRecordType: 'file_asset',
      sourceRecordId: file.id,
      sourceMetadata: {
        fileAssetId: file.id,
        fileName: file.fileName,
        cloudinaryUrl: file.cloudinaryUrl,
      },
      fileAssetId: file.id,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      contentBase64,
    });
  }

  async materializeFromZohoBooksDocument(input: MaterializeFromZohoBooksDocumentInput) {
    const childType = input.kind === 'attachment' ? 'attachments' : 'record_document';
    const auth =
      asRecord(
        await zohoGatewayService.getAuthorizedChildResource({
          domain: 'books',
          module: input.moduleName,
          recordId: input.recordId,
          childType,
          organizationId: input.organizationId?.trim(),
          requester: {
            requesterEmail: input.requesterEmail,
            requesterAiRole: input.requesterAiRole,
          },
        }),
      ) ?? {};
    if (auth.allowed !== true) {
      throw new Error(
        asString(auth.denialReason)
        ?? `You are not allowed to access Zoho Books ${childType} for ${input.moduleName} ${input.recordId}.`,
      );
    }

    const result =
      input.kind === 'attachment'
        ? await zohoBooksClient.getAttachment({
          companyId: input.companyId,
          organizationId: input.organizationId?.trim(),
          moduleName: input.moduleName,
          recordId: input.recordId,
        })
        : await zohoBooksClient.getRecordDocument({
          companyId: input.companyId,
          organizationId: input.organizationId?.trim(),
          moduleName: input.moduleName,
          recordId: input.recordId,
          accept: input.accept ?? 'pdf',
        });

    const payload = asRecord(result.payload) ?? {};
    const contentBase64 = asString(payload.contentBase64);
    if (!contentBase64) {
      throw new Error(`Zoho Books ${childType} for ${input.moduleName} ${input.recordId} had no content.`);
    }
    const contentType =
      asString(payload.contentType)
      ?? (input.kind === 'record_document' && input.accept === 'html'
        ? 'text/html'
        : 'application/pdf');
    const defaultExt = contentType.includes('html') ? 'html' : 'pdf';
    const fallbackName = `${input.moduleName}-${input.recordId}.${defaultExt}`;
    const fileName = inferFileNameFromDisposition(
      asString(payload.contentDisposition),
      fallbackName,
    );

    return this.createArtifact({
      companyId: input.companyId,
      createdByUserId: input.requesterUserId,
      sourceSystem: 'zoho_books',
      sourceKind: input.kind,
      sourceRecordType: input.moduleName,
      sourceRecordId: input.recordId,
      sourceMetadata: {
        organizationId: result.organizationId,
        contentType,
        contentDisposition: asString(payload.contentDisposition),
        accept: input.accept ?? 'pdf',
      },
      fileName,
      mimeType: contentType,
      sizeBytes:
        typeof payload.sizeBytes === 'number' && Number.isFinite(payload.sizeBytes)
          ? payload.sizeBytes
          : undefined,
      contentBase64,
    });
  }
}

export const outboundArtifactService = new OutboundArtifactService();
