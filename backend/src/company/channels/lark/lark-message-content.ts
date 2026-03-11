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
