const readString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const collectTextFragments = (value: unknown): string[] => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectTextFragments(entry));
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  const directText = readString(record.text) ?? readString(record.content);
  if (directText) {
    return [directText];
  }

  if (record.tag === 'at') {
    const mention = readString(record.user_name) ?? readString(record.name);
    return mention ? [`@${mention}`] : [];
  }

  return Object.values(record).flatMap((entry) => collectTextFragments(entry));
};

const parsePostContent = (parsed: Record<string, unknown>): string => {
  const post = parsed.post;
  if (!post || typeof post !== 'object') {
    return '';
  }

  const locales = Object.values(post as Record<string, unknown>);
  for (const locale of locales) {
    if (!locale || typeof locale !== 'object') {
      continue;
    }
    const localeRecord = locale as Record<string, unknown>;
    const fragments = collectTextFragments(localeRecord.content);
    if (fragments.length > 0) {
      return fragments.join(' ').replace(/\s+/g, ' ').trim();
    }
  }

  return '';
};

export const parseLarkMessageContent = (content: unknown, msgType?: string): string => {
  const raw = readString(content);
  if (!raw) {
    return '';
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (msgType === 'post') {
      return parsePostContent(parsed) || raw;
    }
    return readString(parsed.text) ?? parsePostContent(parsed) ?? raw;
  } catch {
    return raw;
  }
};

export type LarkAttachmentKey = {
  key: string;
  fileType: 'image' | 'file';
  /** Lark file_type string e.g. 'pdf', 'docx', 'txt' — for MIME guessing */
  larkFileType?: string;
  /** The original file name if available */
  fileName?: string;
};

/**
 * Extracts attachment keys from Lark message content JSON.
 * Handles:
 *   - msg_type "image"  → { image_key }
 *   - msg_type "file"   → { file_key, file_type, file_name? }
 *   - msg_type "audio"  → ignored (not useful for AI)
 *   - msg_type "sticker"→ ignored
 */
export const parseLarkAttachmentKeys = (content: unknown, msgType?: string): LarkAttachmentKey[] => {
  const raw = typeof content === 'string' ? content.trim() : '';
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (msgType === 'image') {
      const imageKey = readString(parsed.image_key);
      if (imageKey) return [{ key: imageKey, fileType: 'image' }];
    }

    if (msgType === 'file') {
      const fileKey = readString(parsed.file_key);
      const larkFileType = readString(parsed.file_type);
      const fileName = readString(parsed.file_name);
      if (fileKey) return [{ key: fileKey, fileType: 'file', larkFileType, fileName }];
    }
  } catch {
    // silently ignore parse errors, return empty
  }

  return [];
};

