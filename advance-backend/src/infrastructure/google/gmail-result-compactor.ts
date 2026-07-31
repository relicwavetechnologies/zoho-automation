const GMAIL_CONTENT_TOOLS = new Set([
  'search_gmail_messages',
  'get_gmail_message_content',
  'get_gmail_messages_content_batch',
  'get_gmail_thread_content',
  'get_gmail_threads_content_batch',
]);

export const GMAIL_RESULT_LIMITS = Object.freeze({
  maxCharactersPerMessage: 12_000,
  maxCharactersPerThread: 40_000,
  maxCharacters: 60_000,
  maxMessages: 20,
});

type GmailCompactionReason =
  | 'quoted_replies'
  | 'message_character_limit'
  | 'thread_character_limit'
  | 'message_limit'
  | 'character_limit';

export interface GmailResultCompactionMetadata {
  readonly version: 2;
  readonly mode: 'metadata' | 'full';
  readonly truncated: boolean;
  readonly reasons: readonly GmailCompactionReason[];
  readonly originalCharacters: number;
  readonly returnedCharacters: number;
  readonly originalMessages: number;
  readonly returnedMessages: number;
  readonly omittedMessages: number;
  /** Messages returned by Google before Divo changes the model-facing prose. */
  readonly providerReturnedMessages: number;
  /** Complete machine-readable records retained next to the compacted prose. */
  readonly structuredMessages: number;
  /** Message records still visible in the compacted prose. */
  readonly modelVisibleMessages: number;
  readonly requestedPageSize?: number;
  readonly clippedMessages: number;
  readonly clippedThreads: number;
  readonly quotedReplyCharactersRemoved: number;
  readonly limits: typeof GMAIL_RESULT_LIMITS;
  readonly continuation: {
    readonly available: boolean;
    readonly inputField?: 'page_token';
    readonly token?: string;
  };
}

interface TextCompaction {
  readonly text: string;
  readonly metadata: GmailResultCompactionMetadata;
}

/**
 * Shapes Gmail's prose-oriented MCP responses before they cross Divo's tool
 * boundary. The pinned MCP returns formatted strings for Gmail reads, so Divo
 * owns the size and quote-history policy rather than relying on model prompts.
 */
export function compactGmailMcpResult(
  nativeTool: string,
  input: Readonly<Record<string, unknown>>,
  result: unknown,
): unknown {
  if (!GMAIL_CONTENT_TOOLS.has(nativeTool)) return result;

  if (typeof result === 'string') {
    const compacted = compactGmailText(nativeTool, input, result);
    return { text: compacted.text, _divoResult: compacted.metadata };
  }

  if (!isRecord(result)) return result;

  for (const field of ['content', 'text', 'result', 'output'] as const) {
    const value = result[field];
    if (typeof value !== 'string') continue;
    const compacted = compactGmailText(nativeTool, input, value);
    return {
      ...result,
      [field]: compacted.text,
      _divoResult: reconcileStructuredMetadata(nativeTool, result, compacted.metadata),
    };
  }

  return result;
}

export function compactGmailText(
  nativeTool: string,
  input: Readonly<Record<string, unknown>>,
  original: string,
): TextCompaction {
  const reasons = new Set<GmailCompactionReason>();
  const metadataOnly = nativeTool === 'get_gmail_messages_content_batch'
    && input['format'] === 'metadata';
  const canStripQuotedReplies = !metadataOnly
    && input['body_format'] !== 'html'
    && input['body_format'] !== 'raw';

  const originalMessages = countMessages(nativeTool, original);
  let text = original;
  let quotedReplyCharactersRemoved = 0;

  if (canStripQuotedReplies) {
    const stripped = stripQuotedRepliesByMessage(text);
    text = stripped.text;
    quotedReplyCharactersRemoved = stripped.removedCharacters;
    if (quotedReplyCharactersRemoved > 0) reasons.add('quoted_replies');
  }

  const messageCharacterLimited = limitMessageCharacters(
    nativeTool,
    text,
    GMAIL_RESULT_LIMITS.maxCharactersPerMessage,
  );
  text = messageCharacterLimited.text;
  if (messageCharacterLimited.clippedMessages > 0) reasons.add('message_character_limit');

  const threadCharacterLimited = limitThreadCharacters(
    nativeTool,
    text,
    GMAIL_RESULT_LIMITS.maxCharactersPerThread,
  );
  text = threadCharacterLimited.text;
  if (threadCharacterLimited.clippedThreads > 0) reasons.add('thread_character_limit');

  const messageLimited = limitMessages(nativeTool, text, GMAIL_RESULT_LIMITS.maxMessages);
  text = messageLimited.text;
  if (messageLimited.omittedMessages > 0) reasons.add('message_limit');

  if (text.length > GMAIL_RESULT_LIMITS.maxCharacters) {
    text = truncateMiddle(text, GMAIL_RESULT_LIMITS.maxCharacters);
    reasons.add('character_limit');
  }

  const returnedMessages = countMessages(nativeTool, text);
  const omittedMessages = Math.max(
    messageLimited.omittedMessages,
    Math.max(0, originalMessages - returnedMessages),
  );

  return {
    text,
    metadata: {
      version: 2,
      mode: metadataOnly ? 'metadata' : 'full',
      truncated: reasons.size > 0,
      reasons: [...reasons],
      originalCharacters: original.length,
      returnedCharacters: text.length,
      originalMessages,
      returnedMessages,
      omittedMessages,
      providerReturnedMessages: originalMessages,
      structuredMessages: 0,
      modelVisibleMessages: returnedMessages,
      clippedMessages: messageCharacterLimited.clippedMessages,
      clippedThreads: threadCharacterLimited.clippedThreads,
      quotedReplyCharactersRemoved,
      limits: GMAIL_RESULT_LIMITS,
      continuation: { available: false },
    },
  };
}

function reconcileStructuredMetadata(
  nativeTool: string,
  result: Readonly<Record<string, unknown>>,
  metadata: GmailResultCompactionMetadata,
): GmailResultCompactionMetadata {
  const messages = Array.isArray(result['messages']) ? result['messages'] : [];
  const pagination = isRecord(result['pagination']) ? result['pagination'] : undefined;
  const paginationCount = readNonNegativeInteger(pagination?.['providerReturnedMessages']);
  const providerReturnedMessages = paginationCount
    ?? (messages.length > 0 ? messages.length : metadata.originalMessages);
  const structuredMessages = messages.length;
  const modelVisibleMessages = metadata.returnedMessages;
  const requestedPageSize = readPositiveInteger(pagination?.['requestedPageSize']);
  const nextPageToken = typeof pagination?.['nextPageToken'] === 'string'
    && pagination['nextPageToken'].trim()
    ? pagination['nextPageToken'].trim()
    : undefined;
  const hasNextPage = nativeTool === 'search_gmail_messages'
    && pagination?.['hasNextPage'] === true
    && Boolean(nextPageToken);

  return {
    ...metadata,
    originalMessages: providerReturnedMessages,
    returnedMessages: modelVisibleMessages,
    omittedMessages: Math.max(0, providerReturnedMessages - modelVisibleMessages),
    providerReturnedMessages,
    structuredMessages,
    modelVisibleMessages,
    ...(requestedPageSize ? { requestedPageSize } : {}),
    continuation: hasNextPage
      ? { available: true, inputField: 'page_token', token: nextPageToken! }
      : { available: false },
  };
}

function limitMessageCharacters(
  nativeTool: string,
  text: string,
  maxCharacters: number,
): { text: string; clippedMessages: number } {
  const threadSections = splitThreadSections(text);
  if (threadSections.sections.length > 0) {
    let clippedMessages = 0;
    const sections = threadSections.sections.map((section) => {
      const clipped = clipThreadMessages(section, maxCharacters);
      clippedMessages += clipped.clippedMessages;
      return clipped.text;
    });
    return {
      text: threadSections.prefix + sections.join(''),
      clippedMessages,
    };
  }

  if (nativeTool === 'get_gmail_messages_content_batch') {
    let clippedMessages = 0;
    const blocks = text.split('\n---\n').map((block) => {
      if (block.length <= maxCharacters) return block;
      clippedMessages++;
      return truncateWithMarker(
        block,
        maxCharacters,
        `[Divo omitted middle content to enforce the ${maxCharacters}-character per-message limit.]`,
      );
    });
    return { text: blocks.join('\n---\n'), clippedMessages };
  }

  if (nativeTool === 'get_gmail_message_content' && text.length > maxCharacters) {
    return {
      text: truncateWithMarker(
        text,
        maxCharacters,
        `[Divo omitted middle content to enforce the ${maxCharacters}-character per-message limit.]`,
      ),
      clippedMessages: 1,
    };
  }

  return { text, clippedMessages: 0 };
}

function clipThreadMessages(
  section: string,
  maxCharacters: number,
): { text: string; clippedMessages: number } {
  const matches = [...section.matchAll(/^=== Message \d+ ===\s*$/gm)];
  if (matches.length === 0) return { text: section, clippedMessages: 0 };

  const prefix = section.slice(0, matches[0]!.index ?? 0);
  let clippedMessages = 0;
  const messages = matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? section.length;
    const message = section.slice(start, end);
    if (message.length <= maxCharacters) return message;
    clippedMessages++;
    return truncateWithMarker(
      message,
      maxCharacters,
      `[Divo omitted middle content to enforce the ${maxCharacters}-character per-message limit.]`,
    );
  });

  return { text: prefix + messages.join(''), clippedMessages };
}

function limitThreadCharacters(
  nativeTool: string,
  text: string,
  maxCharacters: number,
): { text: string; clippedThreads: number } {
  const threadSections = splitThreadSections(text);
  if (threadSections.sections.length > 0) {
    let clippedThreads = 0;
    const sections = threadSections.sections.map((section) => {
      if (section.length <= maxCharacters) return section;
      clippedThreads++;
      return truncateWithMarker(
        section,
        maxCharacters,
        `[Divo omitted middle content to enforce the ${maxCharacters}-character per-thread limit.]`,
      );
    });
    return {
      text: threadSections.prefix + sections.join(''),
      clippedThreads,
    };
  }

  if (
    (nativeTool === 'get_gmail_thread_content' || nativeTool === 'get_gmail_threads_content_batch')
    && text.length > maxCharacters
  ) {
    return {
      text: truncateWithMarker(
        text,
        maxCharacters,
        `[Divo omitted middle content to enforce the ${maxCharacters}-character per-thread limit.]`,
      ),
      clippedThreads: 1,
    };
  }

  return { text, clippedThreads: 0 };
}

function stripQuotedRepliesByMessage(text: string): { text: string; removedCharacters: number } {
  const threadSections = splitThreadSections(text);
  if (threadSections.sections.length > 0) {
    const sections = threadSections.sections.map((section) => rewriteThreadSection(section, undefined, true));
    const compacted = threadSections.prefix + sections.map((section) => section.text).join('');
    return { text: compacted, removedCharacters: text.length - compacted.length };
  }

  const blocks = text.split('\n---\n');
  const stripped = blocks.map(stripSafeQuotedSuffix);
  const compacted = stripped.join('\n---\n');
  return { text: compacted, removedCharacters: text.length - compacted.length };
}

function stripSafeQuotedSuffix(text: string): string {
  const hadTrailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty >= 0 && lines[lastNonEmpty]!.trim() === '') lastNonEmpty--;
  if (lastNonEmpty < 0) return text;

  let quoteStart = lastNonEmpty;
  let quotedLines = 0;
  while (quoteStart >= 0) {
    const line = lines[quoteStart]!;
    if (line.trim() === '') {
      quoteStart--;
      continue;
    }
    if (/^\s*>/.test(line)) {
      quotedLines++;
      quoteStart--;
      continue;
    }
    break;
  }

  if (quotedLines < 2) return text;

  let cutAt = quoteStart + 1;
  while (cutAt > 0 && lines[cutAt - 1]!.trim() === '') cutAt--;
  if (cutAt === 0 || !/^\s*On .+wrote:\s*$/i.test(lines[cutAt - 1]!)) return text;
  cutAt--;

  const kept = lines.slice(0, cutAt);
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();
  kept.push('[Divo removed quoted reply history]');
  const candidate = kept.join('\n') + (hadTrailingNewline ? '\n' : '');
  return candidate.length < text.length ? candidate : text;
}

function limitMessages(
  nativeTool: string,
  text: string,
  maxMessages: number,
): { text: string; omittedMessages: number } {
  const threadSections = splitThreadSections(text);
  if (threadSections.sections.length > 0) {
    const counts = threadSections.sections.map((section) => messageMarkerCount(section));
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (total <= maxMessages) return { text, omittedMessages: 0 };

    const quotas = allocateMessageQuotas(counts, maxMessages);
    const rewritten = threadSections.sections.map((section, index) =>
      rewriteThreadSection(section, quotas[index] ?? 0, false).text,
    );
    return {
      text: threadSections.prefix + rewritten.join(''),
      omittedMessages: total - quotas.reduce((sum, count) => sum + count, 0),
    };
  }

  if (nativeTool === 'get_gmail_messages_content_batch') {
    const blocks = text.split('\n---\n');
    if (blocks.length <= maxMessages) return { text, omittedMessages: 0 };
    const omitted = blocks.length - maxMessages;
    return {
      text: blocks.slice(0, maxMessages).join('\n---\n')
        + `\n\n[Divo omitted ${omitted} additional messages because the Gmail result limit is ${maxMessages}.]`,
      omittedMessages: omitted,
    };
  }

  if (nativeTool === 'search_gmail_messages') {
    return limitSearchResults(text, maxMessages);
  }

  return { text, omittedMessages: 0 };
}

function limitSearchResults(text: string, maxMessages: number): { text: string; omittedMessages: number } {
  const matches = [...text.matchAll(/^\s{2}\d+\. Message ID:/gm)];
  if (matches.length <= maxMessages) return { text, omittedMessages: 0 };
  const usageIndex = text.search(/^💡 USAGE:/m);
  const cutoff = matches[maxMessages]?.index;
  if (cutoff === undefined) return { text, omittedMessages: 0 };
  const suffix = usageIndex >= 0 ? text.slice(usageIndex) : '';
  const omitted = matches.length - maxMessages;
  return {
    text: text.slice(0, cutoff).trimEnd()
      + `\n\n[Divo omitted ${omitted} additional search results because the Gmail result limit is ${maxMessages}.]\n\n`
      + suffix,
    omittedMessages: omitted,
  };
}

function splitThreadSections(text: string): { prefix: string; sections: string[] } {
  const matches = [...text.matchAll(/^Thread ID:[^\n]*\nSubject:[^\n]*\nMessages:\s*\d+\s*$/gm)];
  if (matches.length === 0) return { prefix: text, sections: [] };

  const firstIndex = matches[0]!.index ?? 0;
  const sections = matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    return text.slice(start, end);
  });
  return { prefix: text.slice(0, firstIndex), sections };
}

function rewriteThreadSection(
  section: string,
  quota: number | undefined,
  stripQuotes: boolean,
): { text: string; originalMessages: number; returnedMessages: number } {
  const matches = [...section.matchAll(/^=== Message \d+ ===\s*$/gm)];
  if (matches.length === 0) return { text: section, originalMessages: 0, returnedMessages: 0 };

  const prefix = section.slice(0, matches[0]!.index ?? 0);
  let messages = matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? section.length;
    const message = section.slice(start, end);
    return stripQuotes ? stripSafeQuotedSuffix(message) : message;
  });

  const originalMessages = messages.length;
  if (quota !== undefined && messages.length > quota) {
    const omitted = messages.length - quota;
    messages = quota === 0 ? [] : messages.slice(-quota);
    return {
      text: prefix
        + `[Divo omitted ${omitted} earlier messages from this thread.]\n\n`
        + messages.join(''),
      originalMessages,
      returnedMessages: messages.length,
    };
  }

  return { text: prefix + messages.join(''), originalMessages, returnedMessages: messages.length };
}

function allocateMessageQuotas(counts: readonly number[], maxMessages: number): number[] {
  const quotas = counts.map(() => 0);
  let remaining = maxMessages;

  for (let index = 0; index < counts.length && remaining > 0; index++) {
    if (counts[index]! <= 0) continue;
    quotas[index] = 1;
    remaining--;
  }

  while (remaining > 0) {
    let selected = -1;
    let largestRemainder = 0;
    for (let index = 0; index < counts.length; index++) {
      const available = counts[index]! - quotas[index]!;
      if (available > largestRemainder) {
        largestRemainder = available;
        selected = index;
      }
    }
    if (selected < 0) break;
    quotas[selected] = quotas[selected]! + 1;
    remaining--;
  }

  return quotas;
}

function truncateMiddle(text: string, maxCharacters: number): string {
  const marker = '\n\n[Divo omitted content because the Gmail character limit was reached.]\n\n';
  return truncateWithMarker(text, maxCharacters, marker);
}

function truncateWithMarker(text: string, maxCharacters: number, markerText: string): string {
  const marker = markerText.startsWith('\n') ? markerText : `\n\n${markerText}\n\n`;
  if (maxCharacters <= marker.length) return marker.slice(0, maxCharacters);
  const available = maxCharacters - marker.length;
  const headLength = Math.floor(available * 0.3);
  const tailLength = available - headLength;
  return text.slice(0, headLength) + marker + text.slice(-tailLength);
}

function countMessages(nativeTool: string, text: string): number {
  const threadMessages = messageMarkerCount(text);
  if (threadMessages > 0) return threadMessages;
  const messageIds = [...text.matchAll(/^Message ID: [^\n]+$/gm)].length;
  if (messageIds > 0) return messageIds;
  const searchIds = [...text.matchAll(/^\s{2}\d+\. Message ID:/gm)].length;
  if (searchIds > 0) return searchIds;
  return nativeTool === 'get_gmail_message_content' && text.length > 0 ? 1 : 0;
}

function messageMarkerCount(text: string): number {
  return [...text.matchAll(/^=== Message \d+ ===\s*$/gm)].length;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
