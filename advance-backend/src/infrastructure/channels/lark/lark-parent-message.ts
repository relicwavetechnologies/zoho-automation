/**
 * Parent message hydration for quote-replies.
 *
 * When a user replies to (quotes) a message and @Divo, the bot needs to see
 * what the quoted message contains — text, images, files. This module fetches
 * the parent message via Lark API, extracts its content, and makes images
 * available as inline multimodal data URLs for the current turn only. Nothing
 * from a quoted message is stored: quoting is a reference, not consent to keep
 * a copy. Documents are pointed back at what Divo already read from them —
 * see `lark-media-support`.
 */
import type { TypedEnv } from '../../../config/env';
import type { Logger } from '../../../shared/logger';
import { Client as LarkSdkClient, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk';
import {
  unsupportedDocumentNotice,
  quotedDocumentNotice,
  isSupportedLarkMedia,
  larkAudioMimeType,
  MAX_INLINE_IMAGE_BYTES,
} from './lark-media-support';
import type { ChannelIdentityRepoPort } from '../../persistence/channel-identity.repository';
import type { ReferencedMessage } from '../../../domain/channel/incoming-message';
import { extractInteractiveCardText } from './lark-message-content';

export type ParentMessageResult = ReferencedMessage & {
  readonly audioAttachment?: {
    readonly fileKey: string;
    readonly fileName: string;
    readonly mimeType: string;
    readonly durationMs: number | null;
    readonly source: 'voice-note' | 'file';
  };
};

export async function fetchParentMessage(input: {
  parentMessageId: string;
  env: TypedEnv;
  logger: Logger;
  channelIdentityRepo: ChannelIdentityRepoPort;
  companyId: string;
  chatId: string;
  tenantKey: string;
  /** False when only stable parent authorship is needed for thread admission. */
  includeContent?: boolean;
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
    if (input.includeContent === false) {
      return {
        messageId: parentMessageId,
        status: 'available',
        messageType: msgType,
        text: '',
        senderExternalId: senderOpenId,
        imageUrls: [],
      };
    }

    let text = '';
    const imageUrls: string[] = [];
    let omittedImageCount = 0;
    let audioAttachment: ParentMessageResult['audioAttachment'];

    if (msgType === 'text') {
      text = (content['text'] as string) ?? '';
    } else if (msgType === 'post') {
      text = extractPostText(content);
      const imageKeys = extractPostImageKeys(content);
      omittedImageCount = Math.max(0, imageKeys.length - MAX_PARENT_IMAGE_COUNT);
      for (const key of imageKeys.slice(0, MAX_PARENT_IMAGE_COUNT)) {
        const url = await downloadParentImage({
          messageId: parentMessageId, imageKey: key, client, log,
        });
        if (url) imageUrls.push(url);
      }
    } else if (msgType === 'image') {
      const imageKey = content['image_key'] as string;
      if (imageKey) {
        const url = await downloadParentImage({
          messageId: parentMessageId, imageKey, client, log,
        });
        if (url) imageUrls.push(url);
      }
    } else if (msgType === 'file') {
      const fileName = (content['file_name'] as string) ?? 'attachment';
      const fileKey = content['file_key'];
      const audioMimeType = larkAudioMimeType(fileName);
      if (audioMimeType && typeof fileKey === 'string' && fileKey) {
        audioAttachment = {
          fileKey,
          fileName,
          mimeType: audioMimeType,
          durationMs: null,
          source: 'file',
        };
      } else {
        // Divo read a quoted document when it arrived, so point at that
        // workspace copy rather than downloading it again. Formats with no
        // reader are refused outright instead of inviting filename guesses.
        text = isSupportedLarkMedia({ type: 'file', fileName })
          ? quotedDocumentNotice(fileName)
          : unsupportedDocumentNotice(fileName);
      }
    } else if (msgType === 'media') {
      text = '[Media/Video]';
    } else if (msgType === 'audio') {
      const fileKey = content['file_key'];
      const duration = Number(content['duration']);
      if (typeof fileKey !== 'string' || !fileKey) {
        return unavailableParent(parentMessageId, 'unsupported', msgType);
      }
      audioAttachment = {
        fileKey,
        fileName: 'voice-note.ogg',
        mimeType: 'audio/ogg',
        durationMs: Number.isFinite(duration) && duration > 0 ? duration : null,
        source: 'voice-note',
      };
    } else if (msgType === 'interactive') {
      text = extractInteractiveCardText(content);
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
      ...(audioAttachment ? { audioAttachment } : {}),
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
/**
 * Shared with the direct-attachment path. A quoted image and an attached one
 * are the same picture; the model should not be able to see one and not the
 * other because of where it was posted.
 */
const MAX_PARENT_IMAGE_DATA_URL_BYTES = MAX_INLINE_IMAGE_BYTES;

async function downloadParentImage(input: {
  messageId: string;
  imageKey: string;
  client: LarkSdkClient;
  log: Logger;
}): Promise<string | null> {
  const { messageId, imageKey, client, log } = input;

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

    // Quoting a message is not consent to keep what was in it. The image is
    // shown to the model for this turn and then dropped: no CDN copy, no
    // indexing, nothing that outlives the request.
    if (buffer.length <= MAX_PARENT_IMAGE_DATA_URL_BYTES) {
      return `data:image/png;base64,${buffer.toString('base64')}`;
    }

    log.warn('parent_message.image_too_large_for_inline', {
      imageKey, sizeBytes: buffer.length, maxBytes: MAX_PARENT_IMAGE_DATA_URL_BYTES,
    });
    return null;
  } catch (e) {
    log.warn('parent_message.image_error', { imageKey, error: String(e) });
    return null;
  }
}
