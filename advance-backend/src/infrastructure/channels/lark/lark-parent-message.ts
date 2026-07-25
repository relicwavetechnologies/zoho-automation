/**
 * Parent message hydration for quote-replies.
 *
 * When a user replies to (quotes) a message and @Divo, the bot needs to see
 * what the quoted message contains — text, images, files. This module fetches
 * the parent message via Lark API, extracts its content, and makes images
 * available as multimodal URLs for the LLM. Background OCR/indexing is queued
 * separately so the AI can answer instantly from inline context.
 */
import type { TypedEnv } from '../../../config/env';
import type { Logger } from '../../../shared/logger';
import { Client as LarkSdkClient, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk';
import type { CloudinaryAdapter } from '../../cloudinary/cloudinary.adapter';
import type { IngestionQueue } from '../../../application/ingestion/ingestion.queue';
import type { ChannelIdentityRepoPort } from '../../persistence/channel-identity.repository';
import type { ReferencedMessage } from '../../../domain/channel/incoming-message';

export type ParentMessageResult = ReferencedMessage;

export async function fetchParentMessage(input: {
  parentMessageId: string;
  env: TypedEnv;
  logger: Logger;
  cloudinaryAdapter?: CloudinaryAdapter;
  ingestionQueue?: IngestionQueue;
  channelIdentityRepo: ChannelIdentityRepoPort;
  companyId: string;
  userId: string;
  chatId: string;
  tenantKey: string;
  sdkClient?: LarkSdkClient;
}): Promise<ParentMessageResult> {
  const { parentMessageId, env, logger, companyId, chatId } = input;
  const log = logger.child({ component: 'parent-message', parentMessageId });

  try {
    const client = input.sdkClient ?? new LarkSdkClient({
      appId: env.LARK_APP_ID,
      appSecret: env.LARK_APP_SECRET,
      domain: env.LARK_API_BASE_URL?.replace(/\/$/, '') || Domain.Lark,
      loggerLevel: LoggerLevel.warn,
      source: 'divo',
    });

    const msg = await fetchLarkMessage(parentMessageId, client, log);
    if (msg.status !== 'available') {
      return unavailableParent(parentMessageId, msg.status);
    }
    if (msg.chatId !== chatId) {
      log.warn('parent_message.chat_mismatch', { expectedChatId: chatId, actualChatId: msg.chatId });
      return unavailableParent(parentMessageId, 'forbidden');
    }

    const { msgType, content, senderOpenId } = msg;
    let text = '';
    const imageUrls: string[] = [];
    let omittedImageCount = 0;

    if (msgType === 'text') {
      text = (content['text'] as string) ?? '';
    } else if (msgType === 'post') {
      text = extractPostText(content);
      const imageKeys = extractPostImageKeys(content);
      omittedImageCount = Math.max(0, imageKeys.length - MAX_PARENT_IMAGE_COUNT);
      for (const key of imageKeys.slice(0, MAX_PARENT_IMAGE_COUNT)) {
        const url = await downloadAndUploadParentImage({
          messageId: parentMessageId, imageKey: key, client,
          ...(input.cloudinaryAdapter ? { cloudinaryAdapter: input.cloudinaryAdapter } : {}),
          ...(input.ingestionQueue ? { ingestionQueue: input.ingestionQueue } : {}),
          companyId, userId: input.userId, chatId, log,
        });
        if (url) imageUrls.push(url);
      }
    } else if (msgType === 'image') {
      const imageKey = content['image_key'] as string;
      if (imageKey) {
        const url = await downloadAndUploadParentImage({
          messageId: parentMessageId, imageKey, client,
          ...(input.cloudinaryAdapter ? { cloudinaryAdapter: input.cloudinaryAdapter } : {}),
          ...(input.ingestionQueue ? { ingestionQueue: input.ingestionQueue } : {}),
          companyId, userId: input.userId, chatId, log,
        });
        if (url) imageUrls.push(url);
      }
    } else if (msgType === 'file') {
      text = `[File: ${(content['file_name'] as string) ?? 'attachment'}]`;
    } else if (msgType === 'media') {
      text = '[Media/Video]';
    } else {
      return unavailableParent(parentMessageId, 'unsupported', msgType);
    }

    let senderName: string | undefined;
    if (senderOpenId) {
      try {
        const resolved = await input.channelIdentityRepo.resolveByLarkTenantIdentity(
          senderOpenId,
          input.tenantKey,
        );
        if (resolved.ok && resolved.value?.companyId === companyId) {
          senderName = resolved.value.displayName ?? resolved.value.email ?? undefined;
        }
      } catch { /* non-fatal */ }
    }

    log.info('parent_message.resolved', {
      msgType, textLength: text.length, imageCount: imageUrls.length,
      hasSenderName: !!senderName,
    });

    return {
      messageId: parentMessageId,
      status: 'available',
      messageType: msgType,
      text: text.trim(),
      senderExternalId: senderOpenId,
      ...(senderName ? { senderName } : {}),
      imageUrls,
      ...(omittedImageCount > 0 ? { omittedImageCount } : {}),
    };
  } catch (e) {
    log.warn('parent_message.error', { error: e instanceof Error ? e.message : String(e) });
    return unavailableParent(parentMessageId, 'unavailable');
  }
}

export function buildParentContextPrefix(ref: ParentMessageResult): string {
  if (ref.status !== 'available') {
    const reason = {
      deleted: 'was deleted or recalled',
      invisible: 'is not visible to Divo',
      forbidden: 'cannot be accessed from this conversation',
      unsupported: `uses an unsupported message type${ref.messageType ? ` (${ref.messageType})` : ''}`,
      unavailable: 'could not be loaded because Lark is temporarily unavailable',
    }[ref.status];
    return `[Referenced message ${reason}. Its contents are unavailable; do not infer or guess them.]`;
  }
  const sender = ref.senderName ?? 'a colleague';
  const omitted = ref.omittedImageCount
    ? ` ${ref.omittedImageCount} additional image${ref.omittedImageCount === 1 ? ' was' : 's were'} omitted.`
    : '';
  if (ref.text) return `[Referenced message from ${sender}: "${ref.text.slice(0, 2000)}"${omitted}]`;
  if (ref.imageUrls.length > 0) return `[Replying to ${sender}'s message (image attached).${omitted}]`;
  return '[Referenced message is available but contains no readable text or image.]';
}

// ── Internal helpers ─────────────────────────────────────────────────────────

type ParentFetchResult =
  | { status: 'available'; msgType: string; content: Record<string, unknown>; senderOpenId: string; chatId: string }
  | { status: 'deleted' | 'invisible' | 'forbidden' | 'unavailable' };

async function fetchLarkMessage(
  messageId: string,
  client: LarkSdkClient,
  log: Logger,
): Promise<ParentFetchResult> {
  try {
    const response = await client.im.v1.message.get({ path: { message_id: messageId } });
    if (response.code !== undefined && response.code !== 0) {
      log.warn('parent_message.fetch_failed', { code: response.code, message: response.msg });
      return { status: classifyParentFetchFailure(response.code) };
    }
    const msg = response.data?.items?.[0];
    if (!msg) return { status: 'invisible' };

    const msgType = msg.msg_type ?? 'text';
    const senderOpenId = msg.sender?.id ?? '';
    const chatId = msg.chat_id ?? '';
    const contentStr = msg.body?.content ?? '{}';

    let content: Record<string, unknown> = {};
    try { content = JSON.parse(contentStr) as Record<string, unknown>; } catch { /* empty */ }

    return { status: 'available', msgType, content, senderOpenId, chatId };
  } catch (e) {
    log.warn('parent_message.fetch_error', { error: String(e) });
    return { status: 'unavailable' };
  }
}

export function classifyParentFetchFailure(
  code: number,
): 'deleted' | 'invisible' | 'forbidden' | 'unavailable' {
  if (code === 230110) return 'deleted';
  if (code === 230073 || code === 230002 || code === 230030) return 'invisible';
  if (code === 230027 || code === 99991672 || code === 99991676) return 'forbidden';
  return 'unavailable';
}

function unavailableParent(
  messageId: string,
  status: Exclude<ParentMessageResult['status'], 'available'>,
  messageType?: string,
): ParentMessageResult {
  return {
    messageId,
    status,
    ...(messageType ? { messageType } : {}),
    text: '',
    senderExternalId: '',
    imageUrls: [],
  };
}

function extractPostText(content: Record<string, unknown>): string {
  const title = (content['title'] as string) ?? '';
  const rows = content['content'] as Array<Array<Record<string, unknown>>> | undefined;
  if (!rows) return title;

  const parts: string[] = [];
  if (title) parts.push(title);

  for (const row of rows) {
    const rowText = row
      .map(block => {
        const tag = block['tag'] as string;
        if (tag === 'text') return (block['text'] as string) ?? '';
        if (tag === 'at') return `@${(block['user_name'] as string) ?? 'someone'}`;
        if (tag === 'a') return (block['text'] as string) ?? (block['href'] as string) ?? '';
        return '';
      })
      .join('');
    if (rowText.trim()) parts.push(rowText);
  }

  return parts.join('\n');
}

function extractPostImageKeys(content: Record<string, unknown>): string[] {
  const rows = content['content'] as Array<Array<Record<string, unknown>>> | undefined;
  if (!rows) return [];

  const keys: string[] = [];
  for (const row of rows) {
    for (const block of row) {
      if (block['tag'] === 'img') {
        const key = block['image_key'] as string;
        if (key) keys.push(key);
      }
    }
  }
  return keys;
}

const MAX_PARENT_IMAGE_COUNT = 4;
const MAX_PARENT_IMAGE_BYTES = 10 * 1_024 * 1_024;
const MAX_PARENT_IMAGE_DATA_URL_BYTES = 1_024 * 1_024;

async function downloadAndUploadParentImage(input: {
  messageId: string;
  imageKey: string;
  client: LarkSdkClient;
  cloudinaryAdapter?: CloudinaryAdapter;
  ingestionQueue?: IngestionQueue;
  companyId: string;
  userId: string;
  chatId: string;
  log: Logger;
}): Promise<string | null> {
  const { messageId, imageKey, client, cloudinaryAdapter, companyId, chatId, log } = input;

  try {
    const resource = await client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: 'image' },
    });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of resource.getReadableStream()) {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bufferChunk.length;
      if (totalBytes > MAX_PARENT_IMAGE_BYTES) {
        log.warn('parent_message.image_too_large', {
          imageKey,
          sizeBytes: totalBytes,
          maxBytes: MAX_PARENT_IMAGE_BYTES,
        });
        return null;
      }
      chunks.push(bufferChunk);
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) return null;

    // Background: queue for OCR/indexing (fire-and-forget)
    if (input.ingestionQueue) {
      input.ingestionQueue.enqueue({
        companyId,
        uploaderUserId: input.userId,
        uploaderChannel: 'lark',
        fileName: `parent_${imageKey}.png`,
        mimeType: 'image/png',
        larkFileKey: imageKey,
        larkMessageId: messageId,
        chatId,
        visibility: 'shared',
        jobType: 'buffer',
        bufferBase64: buffer.toString('base64'),
      }).catch(e => log.warn('parent_message.index_enqueue_failed', { imageKey, error: String(e) }));
    }

    if (cloudinaryAdapter?.isAvailable) {
      try {
        const result = await cloudinaryAdapter.uploadBuffer({
          buffer,
          mimeType: 'image/png',
          fileName: `parent_${imageKey}.png`,
          folder: 'parent_context',
          companyId,
          assetId: imageKey,
          tags: ['parent_context', `chat:${chatId}`],
        });
        return result.secureUrl;
      } catch (e) {
        log.warn('parent_message.cloudinary_failed', { imageKey, error: String(e) });
      }
    }

    if (buffer.length <= MAX_PARENT_IMAGE_DATA_URL_BYTES) {
      return `data:image/png;base64,${buffer.toString('base64')}`;
    }

    return null;
  } catch (e) {
    log.warn('parent_message.image_error', { imageKey, error: String(e) });
    return null;
  }
}
