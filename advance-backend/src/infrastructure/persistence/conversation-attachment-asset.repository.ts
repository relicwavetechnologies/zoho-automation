import type { PrismaClient } from '../../generated/prisma';
import type {
  ConversationAttachmentAsset,
  ConversationAttachmentAssetStore,
} from '../../application/conversation-attachments/conversation-attachment-asset.service';

type RawAssetRow = {
  id: string;
  companyId: string;
  userId: string;
  channel: string;
  conversationKey: string;
  chatId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageProvider: string;
  storageKey: string;
  resourceType: string;
  deliveryType: string;
  receivedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  uncertainAt: Date | null;
};

export class PrismaConversationAttachmentAssetStore implements ConversationAttachmentAssetStore {
  constructor(private readonly prisma: Pick<PrismaClient, '$executeRaw' | '$queryRaw'>) {}

  async create(asset: ConversationAttachmentAsset & {
    readonly threatScanProvider: string | null;
    readonly threatScanVersion: string | null;
    readonly threatScannedAt: Date | null;
  }): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "ConversationAttachmentAsset" (
        "id", "companyId", "userId", "channel", "conversationKey", "chatId",
        "fileName", "mimeType", "sizeBytes", "sha256",
        "storageProvider", "storageKey", "resourceType", "deliveryType",
        "threatScanProvider", "threatScanVersion", "threatScannedAt",
        "receivedAt", "expiresAt", "consumedAt", "uncertainAt"
      ) VALUES (
        ${asset.id}, ${asset.companyId}, ${asset.userId}, ${asset.channel}, ${asset.conversationKey}, ${asset.chatId},
        ${asset.fileName}, ${asset.mimeType}, ${asset.sizeBytes}, ${asset.sha256},
        ${asset.storageProvider}, ${asset.storageKey}, ${asset.resourceType}, ${asset.deliveryType},
        ${asset.threatScanProvider}, ${asset.threatScanVersion}, ${asset.threatScannedAt},
        ${asset.receivedAt}, ${asset.expiresAt}, ${asset.consumedAt}, ${asset.uncertainAt}
      )
    `;
  }

  async listLive(input: {
    companyId: string;
    userId:    string;
    channel:   string;
    chatId:    string;
    now:       Date;
  }): Promise<readonly ConversationAttachmentAsset[]> {
    const rows = await this.prisma.$queryRaw<RawAssetRow[]>`
      SELECT
        "id", "companyId", "userId", "channel", "conversationKey", "chatId",
        "fileName", "mimeType", "sizeBytes", "sha256",
        "storageProvider", "storageKey", "resourceType", "deliveryType",
        "receivedAt", "expiresAt", "consumedAt", "uncertainAt"
      FROM "ConversationAttachmentAsset"
      WHERE "companyId" = ${input.companyId}
        AND "userId" = ${input.userId}
        AND "channel" = ${input.channel}
        AND "chatId" = ${input.chatId}
        AND "expiresAt" > ${input.now}
      ORDER BY "receivedAt" DESC
      LIMIT 50
    `;
    return rows.map(toAsset);
  }

  async listExpired(input: { now: Date; limit: number }): Promise<readonly ConversationAttachmentAsset[]> {
    const rows = await this.prisma.$queryRaw<RawAssetRow[]>`
      SELECT
        "id", "companyId", "userId", "channel", "conversationKey", "chatId",
        "fileName", "mimeType", "sizeBytes", "sha256",
        "storageProvider", "storageKey", "resourceType", "deliveryType",
        "receivedAt", "expiresAt", "consumedAt", "uncertainAt"
      FROM "ConversationAttachmentAsset"
      WHERE "expiresAt" <= ${input.now}
      ORDER BY "expiresAt" ASC
      LIMIT ${input.limit}
    `;
    return rows.map(toAsset);
  }

  async markConsumed(input: { companyId: string; id: string; now: Date }): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "ConversationAttachmentAsset"
      SET "consumedAt" = ${input.now}
      WHERE "companyId" = ${input.companyId}
        AND "id" = ${input.id}
        AND "consumedAt" IS NULL
    `;
  }

  async markUncertain(input: { companyId: string; id: string; now: Date }): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "ConversationAttachmentAsset"
      SET "uncertainAt" = ${input.now}
      WHERE "companyId" = ${input.companyId}
        AND "id" = ${input.id}
        AND "uncertainAt" IS NULL
    `;
  }

  async delete(input: { companyId: string; id: string }): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      DELETE FROM "ConversationAttachmentAsset"
      WHERE "companyId" = ${input.companyId}
        AND "id" = ${input.id}
    `;
    return changed > 0;
  }
}

function toAsset(row: RawAssetRow): ConversationAttachmentAsset {
  if (row.deliveryType !== 'authenticated') {
    throw new Error('Conversation attachment asset has an unsupported delivery type.');
  }
  return {
    ...row,
    deliveryType: row.deliveryType,
  };
}
