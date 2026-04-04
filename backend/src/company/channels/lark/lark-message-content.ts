const readString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export type LarkMention = {
  id?: string;
  openId?: string;
  name?: string;
  token?: string;
};

const PLACEHOLDER_MENTION_RE = /@_user_\d+\b/gi;
const isPlaceholderMention = (value: string | undefined): boolean =>
  typeof value === 'string' && /^@_user_\d+$/i.test(value.trim());

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

const collectMentions = (value: unknown): LarkMention[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectMentions(entry));
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  const mentions: LarkMention[] = [];

  if (record.tag === 'at') {
    const id =
      readString(record.open_id)
      ?? readString(record.user_id)
      ?? readString(record.union_id)
      ?? readString(record.id);
    const openId = readString(record.open_id);
    const name = readString(record.user_name) ?? readString(record.name) ?? readString(record.text);
    const token = isPlaceholderMention(name) ? name : undefined;
    mentions.push({
      ...(id ? { id } : {}),
      ...(openId ? { openId } : {}),
      ...(name ? { name } : {}),
      ...(token ? { token } : {}),
    });
  }

  return [
    ...mentions,
    ...Object.values(record).flatMap((entry) => collectMentions(entry)),
  ];
};

const extractPlaceholderMentions = (value: string): LarkMention[] => {
  const matches = value.match(PLACEHOLDER_MENTION_RE) ?? [];
  return matches.map((match) => ({ name: match, token: match }));
};

const collectRawMentions = (value: unknown): LarkMention[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectRawMentions(entry));
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  const id =
    readString(record.open_id)
    ?? readString(record.openId)
    ?? readString(record.user_id)
    ?? readString(record.userId)
    ?? readString(record.union_id)
    ?? readString(record.id)
    ?? readString(record.key);
  const openId = readString(record.open_id) ?? readString(record.openId);
  const name =
    readString(record.user_name)
    ?? readString(record.userName)
    ?? readString(record.name)
    ?? readString(record.display_name)
    ?? readString(record.displayName)
    ?? readString(record.text);
  const token =
    readString(record.key)
    ?? (isPlaceholderMention(name) ? name : undefined);

  const current = id || name ? [{ ...(id ? { id } : {}), ...(name ? { name } : {}), ...(token ? { token } : {}) }] : [];
  const currentWithOpenId = current.map((entry) => ({
    ...entry,
    ...(openId ? { openId } : {}),
  }));
  return [
    ...currentWithOpenId,
    ...Object.values(record).flatMap((entry) => collectRawMentions(entry)),
  ];
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

export const extractLarkMentions = (content: unknown): LarkMention[] => {
  const raw = readString(content);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return [
      ...collectMentions(parsed),
      ...extractPlaceholderMentions(readString(parsed.text) ?? raw),
    ];
  } catch {
    return extractPlaceholderMentions(raw);
  }
};

export const extractLarkMentionsFromMessage = (input: {
  content: unknown;
  rawMentions?: unknown;
}): LarkMention[] => {
  const mentions = [
    ...extractLarkMentions(input.content),
    ...collectRawMentions(input.rawMentions),
  ];
  const seen = new Set<string>();
  return mentions.filter((mention) => {
    const key = `${mention.id ?? ''}|${mention.token ?? ''}|${mention.name ?? ''}`;
    if (!key.trim() || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

export const replaceLarkMentionTokens = (input: {
  text: string;
  mentions: LarkMention[];
  resolveDisplayName: (mention: LarkMention) => string | null | undefined;
}): string => {
  if (!input.text.trim() || input.mentions.length === 0) {
    return input.text;
  }

  const mentionsByToken = new Map<string, LarkMention[]>();
  for (const mention of input.mentions) {
    const token = mention.token?.trim();
    if (!token) continue;
    const bucket = mentionsByToken.get(token) ?? [];
    bucket.push(mention);
    mentionsByToken.set(token, bucket);
  }

  return input.text.replace(PLACEHOLDER_MENTION_RE, (match) => {
    const bucket = mentionsByToken.get(match);
    const mention = bucket?.shift();
    const resolvedName = mention ? input.resolveDisplayName(mention) : null;
    if (!resolvedName) {
      return match;
    }
    return resolvedName.startsWith('@') ? resolvedName : `@${resolvedName}`;
  });
};

export const resolveLarkMentions = (
  text: string,
  mentions: Array<{
    key: string;
    name: string;
    id?: {
      open_id?: string;
    };
  }>,
): string => {
  if (!mentions?.length) {
    return text;
  }

  let resolved = text;
  for (const mention of mentions) {
    if (!mention.key || !mention.name) {
      continue;
    }
    const suffix = mention.id?.open_id ? ` (open_id:${mention.id.open_id})` : '';
    resolved = resolved.replaceAll(
      mention.key,
      `@${mention.name}${suffix}`,
    );
  }
  return resolved;
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
