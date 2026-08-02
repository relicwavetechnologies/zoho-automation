/**
 * Parse Lark message events to extract file/image/audio attachments.
 *
 * Lark sends attachments via:
 *   - message_type = 'file'  → content.file_key
 *   - message_type = 'image' → content.image_key
 *   - message_type = 'audio' → content.file_key + duration
 *   - message_type = 'post'  → rich text, images inside paragraphs
 *   - message_type = 'sticker' → skip
 */

import { larkAudioMimeType } from './lark-media-support';

export interface LarkAttachment {
  type:       'file' | 'image';
  key:        string;
  fileName:   string;
  mimeType:   string;
  /** Lark message_id — required for the message-resource download endpoint. */
  messageId:  string;
}

export interface LarkAudioAttachment {
  type:       'audio';
  source:     'voice-note' | 'file';
  key:        string;
  fileName:   string;
  mimeType:   string;
  messageId:  string;
  durationMs: number | null;
}

export type LarkMessageAttachment = LarkAttachment | LarkAudioAttachment;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  bmp:  'image/bmp',
  tiff: 'image/tiff',
};

function mimeForImage(key: string): string {
  const ext = key.split('.').at(-1)?.toLowerCase() ?? '';
  return IMAGE_MIME_BY_EXT[ext] ?? 'image/jpeg';
}

function mimeForFile(fileName: string): string {
  const ext = fileName.split('.').at(-1)?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    pdf:  'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc:  'application/msword',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls:  'application/vnd.ms-excel',
    csv:  'text/csv',
    tsv:  'text/tab-separated-values',
    txt:  'text/plain',
    md:   'text/markdown',
    json: 'application/json',
  };
  return map[ext] ?? 'application/octet-stream';
}

export function parseLarkAttachments(raw: unknown): LarkMessageAttachment[] {
  const event = raw as Record<string, unknown>;
  const eventData = event['event'] as Record<string, unknown> | undefined;
  const message  = eventData?.['message'] as Record<string, unknown> | undefined;
  if (!message) return [];

  const messageId   = (message['message_id'] as string | undefined) ?? '';
  const messageType = (message['message_type'] as string | undefined) ?? 'text';
  const contentRaw  = message['content'] as string | undefined;

  let parsed: Record<string, unknown> = {};
  if (contentRaw) {
    try { parsed = JSON.parse(contentRaw) as Record<string, unknown>; } catch { /* ignore */ }
  }

  const results: LarkMessageAttachment[] = [];
  const seenKeys = new Set<string>();

  if (messageType === 'file') {
    const fileKey  = (parsed['file_key'] as string | undefined) ?? '';
    const fileName = (parsed['file_name'] as string | undefined) ?? 'file';
    if (fileKey && !seenKeys.has(fileKey)) {
      seenKeys.add(fileKey);
      const audioMimeType = larkAudioMimeType(fileName);
      results.push(audioMimeType
        ? {
            type: 'audio', source: 'file', key: fileKey, fileName,
            mimeType: audioMimeType, messageId, durationMs: null,
          }
        : { type: 'file', key: fileKey, fileName, mimeType: mimeForFile(fileName), messageId });
    }
  } else if (messageType === 'audio') {
    const fileKey = (parsed['file_key'] as string | undefined) ?? '';
    const duration = Number(parsed['duration']);
    if (fileKey && !seenKeys.has(fileKey)) {
      seenKeys.add(fileKey);
      results.push({
        type: 'audio',
        source: 'voice-note',
        key: fileKey,
        fileName: 'voice-note.ogg',
        mimeType: 'audio/ogg',
        messageId,
        durationMs: Number.isFinite(duration) && duration > 0 ? duration : null,
      });
    }
  } else if (messageType === 'image') {
    const imageKey = (parsed['image_key'] as string | undefined) ?? '';
    if (imageKey && !seenKeys.has(imageKey)) {
      seenKeys.add(imageKey);
      results.push({ type: 'image', key: imageKey, fileName: `image_${imageKey.slice(-8)}.jpg`, mimeType: 'image/jpeg', messageId });
    }
  } else if (messageType === 'post') {
    // Walk the paragraph tree for img tags
    const paragraphs = (parsed['content'] as unknown[][] | undefined) ?? [];
    for (const para of paragraphs) {
      for (const block of para) {
        const b = block as Record<string, unknown>;
        if (b['tag'] === 'img') {
          const imageKey = (b['image_key'] as string | undefined) ?? '';
          if (imageKey && !seenKeys.has(imageKey)) {
            seenKeys.add(imageKey);
            results.push({
              type:      'image',
              key:       imageKey,
              fileName:  `image_${imageKey.slice(-8)}.jpg`,
              mimeType:  mimeForImage(imageKey),
              messageId,
            });
          }
        }
      }
    }
  }

  return results;
}
