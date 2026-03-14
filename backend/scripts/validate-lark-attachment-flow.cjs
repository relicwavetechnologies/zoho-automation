#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { PrismaClient } = require('../src/generated/prisma');
const { createLarkWebhookEventHandler } = require('../dist/company/channels/lark/lark.webhook.routes');
const { fileUploadService } = require('../dist/modules/file-upload/file-upload.service');
const { larkRecentFilesStore } = require('../dist/company/channels/lark/lark-recent-files.store');
const { buildVisionContent } = require('../dist/modules/desktop-chat/file-vision.builder');

const prisma = new PrismaClient();

const SAMPLE_IMAGE_PATH = path.resolve(__dirname, '../../desktop/src/renderer/src/assets/document.png');

const createResponse = () => ({
  statusCode: 200,
  body: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

const runHandler = async (handler, request) => {
  const response = createResponse();
  let nextError;
  await handler(request, response, (error) => {
    if (error) nextError = error;
  });
  if (nextError) throw nextError;
  return response;
};

const pickContext = async () => {
  const link = await prisma.larkUserAuthLink.findFirst({
    where: { revokedAt: null },
    orderBy: { linkedAt: 'desc' },
    select: {
      companyId: true,
      userId: true,
      larkOpenId: true,
      larkUserId: true,
      larkTenantKey: true,
    },
  });

  if (!link) {
    throw new Error('No active Lark user auth link found in DB');
  }

  const identity = await prisma.channelIdentity.findFirst({
    where: {
      companyId: link.companyId,
      channel: 'lark',
      OR: [
        ...(link.larkOpenId ? [{ larkOpenId: link.larkOpenId }] : []),
        ...(link.larkUserId ? [{ larkUserId: link.larkUserId }] : []),
      ],
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      aiRole: true,
      externalUserId: true,
      externalTenantId: true,
      larkOpenId: true,
      larkUserId: true,
    },
  });

  if (!identity) {
    throw new Error('No matching Lark channel identity found for the latest linked user');
  }

  return {
    companyId: link.companyId,
    linkedUserId: link.userId,
    larkTenantKey: link.larkTenantKey,
    larkOpenId: link.larkOpenId || identity.larkOpenId || identity.externalUserId,
    larkUserId: link.larkUserId || identity.larkUserId || undefined,
    channelIdentityId: identity.id,
    requesterAiRole: identity.aiRole || 'MEMBER',
    externalUserId: identity.externalUserId,
  };
};

const cleanupAssets = async (ids) => {
  for (const id of ids) {
    try {
      await fileUploadService.deleteFile(id, undefined);
    } catch {
      // best effort
    }
  }
};

const main = async () => {
  const createdAssetIds = [];
  try {
    const context = await pickContext();
    const imageBuffer = fs.readFileSync(SAMPLE_IMAGE_PATH);
    const chatId = `oc_validate_${Date.now()}`;
    const imageMessageId = `om_validate_image_${Date.now()}`;
    const textMessageId = `om_validate_text_${Date.now()}`;
    let attachmentEnqueueCount = 0;
    let textEnqueueCount = 0;

    const sharedDeps = {
      verifyRequest: () => ({ ok: true }),
      adapter: {
        normalizeIncomingEvent: (event) => ({
          channel: 'lark',
          userId: context.externalUserId,
          chatId,
          chatType: 'p2p',
          messageId: event.event.message.message_id,
          timestamp: new Date().toISOString(),
          text: event.event.message.msg_type === 'text'
            ? 'identify what is in the img'
            : '[User attached an image]',
          rawEvent: event,
          trace: {
            larkTenantKey: context.larkTenantKey,
            larkOpenId: context.larkOpenId,
            larkUserId: context.larkUserId,
          },
        }),
        sendMessage: async () => ({ status: 'sent' }),
        downloadFile: async () => ({
          buffer: imageBuffer,
          contentType: 'image/png',
        }),
      },
      claimIngressKey: async () => true,
      resolveHitlAction: async () => false,
      resolveCompanyIdByTenantKey: async () => context.companyId,
      resolveWorkspaceVerificationConfig: async () => ({
        verificationToken: 'unused',
      }),
      upsertChannelIdentity: async () => ({
        id: context.channelIdentityId,
        isNew: false,
        aiRole: context.requesterAiRole,
      }),
      resolveLinkedUserId: async () => context.linkedUserId,
    };

    const attachmentHandler = createLarkWebhookEventHandler({
      ...sharedDeps,
      parsePayload: () => ({
        kind: 'event_callback_message',
        envelope: {
          event: {
            sender: {
              sender_id: {
                open_id: context.larkOpenId,
                user_id: context.larkUserId,
              },
            },
            message: {
              msg_type: 'image',
              message_id: imageMessageId,
              chat_id: chatId,
              content: JSON.stringify({ image_key: 'img_validate' }),
            },
          },
        },
        eventType: 'im.message.receive_v1',
        eventId: `evt_validate_image_${Date.now()}`,
        larkTenantKey: context.larkTenantKey,
      }),
      enqueueTask: async () => {
        attachmentEnqueueCount += 1;
        return { taskId: 'task_should_not_enqueue' };
      },
    });

    const attachmentResponse = await runHandler(attachmentHandler, {
      headers: {},
      body: {},
      rawBody: '{}',
      requestId: 'validate-lark-attachment-flow-image',
      method: 'POST',
      originalUrl: '/webhooks/lark/events',
      url: '/webhooks/lark/events',
    });

    const createdAsset = await prisma.fileAsset.findFirst({
      where: {
        companyId: context.companyId,
        uploaderUserId: context.linkedUserId,
        uploaderChannel: 'lark',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        cloudinaryPublicId: true,
        cloudinaryUrl: true,
        createdAt: true,
      },
    });

    if (!createdAsset) {
      throw new Error('No FileAsset was created by the attachment-only Lark event');
    }
    createdAssetIds.push(createdAsset.id);

    const visibleFiles = await fileUploadService.listVisibleFiles({
      companyId: context.companyId,
      requesterUserId: context.linkedUserId,
      requesterAiRole: context.requesterAiRole,
      isAdmin: ['SUPER_ADMIN', 'COMPANY_ADMIN'].includes(context.requesterAiRole),
    });

    const pendingBeforeText = larkRecentFilesStore.get(chatId);
    const textHandler = createLarkWebhookEventHandler({
      ...sharedDeps,
      parsePayload: () => ({
        kind: 'event_callback_message',
        envelope: {
          event: {
            sender: {
              sender_id: {
                open_id: context.larkOpenId,
                user_id: context.larkUserId,
              },
            },
            message: {
              msg_type: 'text',
              message_id: textMessageId,
              chat_id: chatId,
              content: JSON.stringify({ text: 'identify what is in the img' }),
            },
          },
        },
        eventType: 'im.message.receive_v1',
        eventId: `evt_validate_text_${Date.now()}`,
        larkTenantKey: context.larkTenantKey,
      }),
      enqueueTask: async () => {
        textEnqueueCount += 1;
        return { taskId: 'task_should_enqueue_once' };
      },
    });

    const textResponse = await runHandler(textHandler, {
      headers: {},
      body: {},
      rawBody: '{}',
      requestId: 'validate-lark-attachment-flow-text',
      method: 'POST',
      originalUrl: '/webhooks/lark/events',
      url: '/webhooks/lark/events',
    });

    const consumedForVision = larkRecentFilesStore.consume(chatId);
    const visionParts = await buildVisionContent({
      userMessage: 'identify what is in the img',
      attachedFiles: consumedForVision,
      companyId: context.companyId,
      requesterUserId: context.linkedUserId,
      requesterAiRole: context.requesterAiRole,
    });
    const consumedAgain = larkRecentFilesStore.consume(chatId);

    const latestSession = await prisma.memberSession.findFirst({
      where: {
        userId: context.linkedUserId,
        companyId: context.companyId,
        revokedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        sessionId: true,
        channel: true,
        authProvider: true,
        larkOpenId: true,
        larkUserId: true,
        createdAt: true,
      },
    });

    const report = {
      attachmentResponseStatus: attachmentResponse.statusCode,
      attachmentResponseMessage: attachmentResponse.body?.message,
      attachmentEnqueueCount,
      textResponseStatus: textResponse.statusCode,
      textResponseMessage: textResponse.body?.message,
      textEnqueueCount,
      createdAsset,
      visibleInDrawer: visibleFiles.some((file) => file.id === createdAsset.id),
      pendingBeforeTextCount: pendingBeforeText.length,
      consumedForVisionCount: consumedForVision.length,
      consumedAgainCount: consumedAgain.length,
      visionPartTypes: visionParts.map((part) => part.type),
      visionImagePartCount: visionParts.filter((part) => part.type === 'image').length,
      latestSession,
    };

    console.log(JSON.stringify(report, null, 2));

    if (attachmentEnqueueCount !== 0) {
      throw new Error('Attachment-only Lark event still enqueued a task');
    }
    if (textEnqueueCount !== 1) {
      throw new Error(`Follow-up text event should enqueue exactly once, got ${textEnqueueCount}`);
    }
    if (!visibleFiles.some((file) => file.id === createdAsset.id)) {
      throw new Error('Created asset is not visible via the file drawer visibility query');
    }
    if (pendingBeforeText.length === 0 || consumedForVision.length === 0 || consumedAgain.length !== 0) {
      throw new Error('Recent attachment staging did not behave as one-shot pending context');
    }
    if (!visionParts.some((part) => part.type === 'image')) {
      throw new Error('Follow-up text turn did not resolve the staged image into a vision image part');
    }
  } finally {
    await prisma.$disconnect();
  }
};

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});
