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
  if (record.tag === 'img' || record.tag === 'media' || record.tag === 'file') {
    return [];
  }
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

const collectPostBodies = (parsed: Record<string, unknown>): unknown[] => {
  const bodies: unknown[] = [];

  if (Array.isArray(parsed.content)) {
    bodies.push(parsed.content);
  }

  const post = parsed.post;
  if (post && typeof post === 'object') {
    const locales = Object.values(post as Record<string, unknown>);
    for (const locale of locales) {
      if (!locale || typeof locale !== 'object') {
        continue;
      }
      const localeRecord = locale as Record<string, unknown>;
      if (localeRecord.content !== undefined) {
        bodies.push(localeRecord.content);
      }
    }
  }

  return bodies;
};

const parsePostContent = (parsed: Record<string, unknown>): string => {
  const bodies = collectPostBodies(parsed);
  for (const body of bodies) {
    const fragments = collectTextFragments(body);
    if (fragments.length > 0) {
      return fragments.join(' ').replace(/\s+/g, ' ').trim();
    }
  }

  return '';
};

const parseContentRecord = (content: unknown): Record<string, unknown> | null => {
  const raw = readString(content);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const inferLarkMessageType = (input: {
  msgType?: string | null;
  altMsgType?: string | null;
  content?: unknown;
}): 'text' | 'post' | 'image' | 'file' | 'media' => {
  const directType = readString(input.msgType) ?? readString(input.altMsgType);
  if (
    directType === 'text'
    || directType === 'post'
    || directType === 'image'
    || directType === 'file'
    || directType === 'media'
  ) {
    return directType;
  }

  const parsed = parseContentRecord(input.content);
  if (parsed) {
    if (readString(parsed.image_key)) {
      return 'image';
    }
    if (readString(parsed.file_key)) {
      return 'file';
    }
    if (Array.isArray(parsed.content) || (parsed.post && typeof parsed.post === 'object')) {
      return 'post';
    }
  }

  return 'text';
};

export const parseLarkMessageContent = (content: unknown, msgType?: string): string => {
  const raw = readString(content);
  if (!raw) {
    return '';
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (msgType === 'image') {
      return '[User attached an image]';
    }
    if (msgType === 'file') {
      const fileName = readString(parsed.file_name);
      return fileName ? `[User attached a file: ${fileName}]` : '[User attached a file]';
    }
    if (msgType === 'media') {
      const fileName = readString(parsed.file_name) ?? readString(parsed.title);
      return fileName ? `[User attached media: ${fileName}]` : '[User attached media]';
    }
    if (msgType === 'post') {
      return parsePostContent(parsed) || raw;
    }
    const parsedText = readString(parsed.text);
    if (parsedText) {
      return parsedText;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, 'text')) {
      return '';
    }
    const postText = parsePostContent(parsed);
    return postText || raw;
  } catch {
    if (msgType === 'image') {
      return '[User attached an image]';
    }
    if (msgType === 'file') {
      return '[User attached a file]';
    }
    if (msgType === 'media') {
      return '[User attached media]';
    }
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

const collectAttachmentKeys = (value: unknown): LarkAttachmentKey[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectAttachmentKeys(entry));
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  const imageKey = readString(record.image_key);
  if (imageKey) {
    return [{ key: imageKey, fileType: 'image' }];
  }

  const fileKey = readString(record.file_key);
  if (fileKey) {
    return [{
      key: fileKey,
      fileType: 'file',
      larkFileType: readString(record.file_type),
      fileName: readString(record.file_name),
    }];
  }

  return Object.values(record).flatMap((entry) => collectAttachmentKeys(entry));
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
    const dedupe = (keys: LarkAttachmentKey[]): LarkAttachmentKey[] => {
      const seen = new Set<string>();
      return keys.filter((key) => {
        const composite = `${key.fileType}:${key.key}`;
        if (seen.has(composite)) {
          return false;
        }
        seen.add(composite);
        return true;
      });
    };

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

    if (msgType === 'media') {
      const fileKey = readString(parsed.file_key);
      const larkFileType = readString(parsed.file_type) ?? readString(parsed.media_type);
      const fileName = readString(parsed.file_name) ?? readString(parsed.title);
      if (fileKey) return [{ key: fileKey, fileType: 'file', larkFileType, fileName }];
    }

    if (msgType === 'post') {
      return dedupe(collectAttachmentKeys(parsed));
    }

    return dedupe(collectAttachmentKeys(parsed));
  } catch {
    // silently ignore parse errors, return empty
  }

  return [];
};
