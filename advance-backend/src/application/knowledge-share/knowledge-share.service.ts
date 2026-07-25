import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma';
import type { FileAssetRepository } from '../../infrastructure/persistence/file-asset.repository';
import type { FileAccessPolicyRepository } from '../../infrastructure/persistence/file-access-policy.repository';
import type { VectorDocumentRepository } from '../../infrastructure/persistence/vector-document.repository';
import type { QdrantAdapter } from '../../infrastructure/ai/vector/qdrant.adapter';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import type { CachePort } from '../../shared/cache';
import type { Logger } from '../../shared/logger';
import { classifyForShare } from './share-classifier';
import { buildShareApprovalCard } from './share-card-builder';

export const SHARE_CACHE_PREFIX = 'share:request:';
export const SHARE_CACHE_TTL_S  = 60 * 60 * 24 * 7; // 7 days

export interface ShareRequest {
  shareId:          string;
  fileAssetId:      string;
  companyId:        string;
  requesterUserId:  string;
  requesterOpenId:  string;
  requesterName:    string;
  fileName:         string;
  label:            'safe' | 'review' | 'critical';
  cardMessageIds:   string[];   // admin DM message IDs for in-place updates
  createdAt:        string;
}

export interface KnowledgeShareResult {
  outcome: 'auto_promoted' | 'pending_review' | 'blocked';
  message: string;
}

export class KnowledgeShareService {
  private readonly log: Logger;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly fileAssetRepo: FileAssetRepository,
    private readonly fileAccessPolicyRepo: FileAccessPolicyRepository,
    private readonly vectorDocRepo: VectorDocumentRepository,
    private readonly qdrant: QdrantAdapter,
    private readonly larkAdapter: LarkChannelAdapter,
    private readonly cache: CachePort,
    logger: Logger,
  ) {
    this.log = logger.child({ service: 'knowledge-share' });
  }

  async requestShare(input: {
    companyId:       string;
    requesterUserId: string;
    requesterOpenId: string;
    requesterName:   string;
    fileAssetId?:    string;  // if omitted, find most recent personal file
  }): Promise<KnowledgeShareResult> {
    // Resolve file
    let fileAsset: { id: string; fileName: string; mimeType: string; companyId: string } | null = null;

    if (input.fileAssetId) {
      const result = await this.fileAssetRepo.findById(input.fileAssetId);
      if (result.ok && result.value && result.value.companyId === input.companyId) {
        fileAsset = result.value;
      }
    } else {
      const result = await this.fileAssetRepo.findLatestPersonalByUser(input.companyId, input.requesterUserId);
      if (result.ok) fileAsset = result.value;
    }

    if (!fileAsset) {
      return { outcome: 'blocked', message: 'No indexed file found. Upload and index a file first.' };
    }

    // Get a sample of chunk text for classification
    const chunksResult = await this.vectorDocRepo.findByFileAsset(fileAsset.id);
    const sampleText = chunksResult.ok
      ? chunksResult.value.slice(0, 3).map(c => c.chunkText ?? '').join(' ')
      : '';

    const label = classifyForShare({ fileName: fileAsset.fileName, mimeType: fileAsset.mimeType, sampleText });

    this.log.info('knowledge-share.classify', { fileAssetId: fileAsset.id, label, fileName: fileAsset.fileName });

    if (label === 'critical') {
      return {
        outcome: 'blocked',
        message: `**${fileAsset.fileName}** is classified as sensitive (confidential/financial/PII). Contact an admin to share manually.`,
      };
    }

    if (label === 'safe') {
      // Auto-promote: update Qdrant + Prisma visibility, add access policies for all roles
      await this.promoteToShared(fileAsset.id, input.companyId, input.requesterUserId);
      return {
        outcome: 'auto_promoted',
        message: `✅ **${fileAsset.fileName}** is now shared with your team.`,
      };
    }

    // label === 'review': create pending share request + send admin cards
    const shareId = randomUUID();
    const shareRequest: ShareRequest = {
      shareId,
      fileAssetId:      fileAsset.id,
      companyId:        input.companyId,
      requesterUserId:  input.requesterUserId,
      requesterOpenId:  input.requesterOpenId,
      requesterName:    input.requesterName,
      fileName:         fileAsset.fileName,
      label,
      cardMessageIds:   [],
      createdAt:        new Date().toISOString(),
    };

    const adminMemberships = await this.prisma.adminMembership.findMany({
      where: {
        companyId: input.companyId,
        isActive: true,
        role: { in: ['COMPANY_ADMIN', 'SUPER_ADMIN'] },
      },
      select: { userId: true },
    });
    const adminUserIds = adminMemberships.map(admin => admin.userId);
    const admins = adminUserIds.length > 0
      ? await this.prisma.integrationConnection.findMany({
          where: {
            companyId: input.companyId,
            provider: 'lark',
            ownerUserId: { in: adminUserIds },
            status: 'connected',
            revokedAt: null,
            externalAccountId: { not: null },
          },
          select: {
            externalAccountId: true,
            ownerUser: { select: { name: true } },
          },
          orderBy: { updatedAt: 'desc' },
        })
      : [];

    const cardContent = buildShareApprovalCard({
      shareId,
      fileName:      fileAsset.fileName,
      requesterName: input.requesterName,
      label,
      companyId:     input.companyId,
    });

    const cardMessageIds: string[] = [];
    for (const admin of admins) {
      if (!admin.externalAccountId) continue;
      try {
        const result = await this.larkAdapter.sendDirectCard(admin.externalAccountId, cardContent);
        if (result.ok) cardMessageIds.push(result.value.messageId);
      } catch { /* non-fatal — at least one admin card sent */ }
    }

    shareRequest.cardMessageIds = cardMessageIds;
    await this.cache.set(`${SHARE_CACHE_PREFIX}${shareId}`, shareRequest, SHARE_CACHE_TTL_S);

    this.log.info('knowledge-share.pending', { shareId, fileAssetId: fileAsset.id, adminCardsCount: cardMessageIds.length });

    return {
      outcome: 'pending_review',
      message: `📤 **${fileAsset.fileName}** has been sent to admins for approval.`,
    };
  }

  async promoteToShared(fileAssetId: string, companyId: string, requesterId: string): Promise<void> {
    // Update Qdrant payload — makes vectors retrievable by all company members
    await this.qdrant.updateVisibilityForFileAsset({ companyId, fileAssetId, visibility: 'shared' });
    // Update Postgres VectorDocument rows
    await this.vectorDocRepo.updateVisibility(fileAssetId, 'shared');
    // Add access policy rows for every distinct role in this company so the file
    // appears in listVisible() for all users (not just the uploader).
    const distinctRoles = await this.prisma.channelIdentity.findMany({
      where: { companyId },
      distinct: ['aiRole'],
      select: { aiRole: true },
    });
    const roles = [...new Set(distinctRoles.map((r: { aiRole: string }) => r.aiRole))];
    await this.fileAccessPolicyRepo.replaceForFileAsset(fileAssetId, companyId, requesterId, roles);
  }
}
