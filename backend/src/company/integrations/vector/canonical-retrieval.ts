import { createHash } from 'crypto';

import type { VectorUpsertDTO } from '../../contracts';
import type { CanonicalRetrievalChunk, RetrievalProfile } from './retrieval-contract';
import { ACTIVE_EMBEDDING_SCHEMA_VERSION } from './retrieval-contract';

const FIELD_LABELS: Record<string, string> = {
  First_Name: 'First name',
  Last_Name: 'Last name',
  Full_Name: 'Full name',
  Email: 'Email',
  Phone: 'Phone',
  Mobile: 'Mobile',
  Company: 'Company',
  Account_Name: 'Account',
  Deal_Name: 'Deal',
  Stage: 'Stage',
  Amount: 'Amount',
  Lead_Status: 'Lead status',
  Contact_Name: 'Contact name',
  Ticket_Title: 'Ticket title',
  Subject: 'Subject',
  Description: 'Description',
  Notes: 'Notes',
  Website: 'Website',
  Industry: 'Industry',
  City: 'City',
  State: 'State',
  Country: 'Country',
  Owner: 'Owner',
  Created_Time: 'Created',
  Modified_Time: 'Updated',
};

const chunkTargets: Record<RetrievalProfile, { targetTokens: number; overlapTokens: number }> = {
  zoho: { targetTokens: 320, overlapTokens: 64 },
  file: { targetTokens: 900, overlapTokens: 180 },
  chat: { targetTokens: 192, overlapTokens: 32 },
};

const normalizeWhitespace = (value: string): string =>
  value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const toWords = (value: string): string[] =>
  value
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);

const joinWords = (words: string[]): string => words.join(' ').trim();

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const stableHash = (value: string): string => createHash('sha256').update(value).digest('hex');

const splitParagraphs = (value: string): string[] =>
  normalizeWhitespace(value)
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const splitLongParagraph = (value: string, targetTokens: number): string[] => {
  const words = toWords(value);
  if (words.length <= targetTokens) {
    return [value.trim()];
  }

  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += targetTokens) {
    chunks.push(joinWords(words.slice(index, index + targetTokens)));
  }
  return chunks.filter((chunk) => chunk.length > 0);
};

const chunkContent = (value: string, profile: RetrievalProfile): string[] => {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return [];

  const { targetTokens, overlapTokens } = chunkTargets[profile];
  const paragraphs = splitParagraphs(normalized).flatMap((paragraph) =>
    splitLongParagraph(paragraph, targetTokens),
  );
  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(normalizeWhitespace(current.join('\n\n')));
    const trailingWords = toWords(current.join(' '));
    current =
      overlapTokens > 0
        ? [joinWords(trailingWords.slice(Math.max(0, trailingWords.length - overlapTokens)))]
        : [];
    currentWords = current.length > 0 ? toWords(current[0]).length : 0;
  };

  for (const paragraph of paragraphs) {
    const words = toWords(paragraph);
    if (currentWords > 0 && currentWords + words.length > targetTokens) {
      flush();
    }
    current.push(paragraph);
    currentWords += words.length;
  }

  flush();
  return chunks.filter((chunk) => chunk.length > 0);
};

const estimateTokenCount = (value: string): number => {
  const words = toWords(value);
  return Math.max(1, Math.ceil(words.length * 1.3));
};

const describeValue = (key: string, value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return `${FIELD_LABELS[key] ?? key}: ${trimmed}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${FIELD_LABELS[key] ?? key}: ${String(value)}`;
  }
  if (Array.isArray(value)) {
    const joined = value
      .map((entry) => readString(entry) ?? (typeof entry === 'number' ? String(entry) : null))
      .filter((entry): entry is string => Boolean(entry))
      .join(', ');
    return joined ? `${FIELD_LABELS[key] ?? key}: ${joined}` : null;
  }
  return null;
};

const pickFirst = (payload: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = readString(payload[key]);
    if (value) return value;
  }
  return null;
};

const extractProfileMemoryLines = (value: string): string[] => {
  const lines: string[] = [];
  const normalized = normalizeWhitespace(value);
  if (!normalized) return lines;

  const favoriteMatch = normalized.match(/\bmy (?:fav|favou?rite)\s+([a-z][a-z0-9 _-]{1,40}?)\s+is\s+(.+?)(?:[.!?]|$)/i);
  if (favoriteMatch) {
    const topic = favoriteMatch[1]?.trim();
    const answer = favoriteMatch[2]?.trim();
    if (topic && answer) {
      lines.push(`User favorite ${topic}: ${answer}`);
    }
  }

  const nameMatch = normalized.match(/\bmy name is\s+(.+?)(?:[.!?]|$)/i);
  if (nameMatch?.[1]?.trim()) {
    lines.push(`User name: ${nameMatch[1].trim()}`);
  }

  const preferMatch = normalized.match(/\bi prefer\s+(.+?)(?:[.!?]|$)/i);
  if (preferMatch?.[1]?.trim()) {
    lines.push(`User prefers: ${preferMatch[1].trim()}`);
  }

  const likeMatch = normalized.match(/\bi (?:really )?(?:like|love)\s+(.+?)(?:[.!?]|$)/i);
  if (likeMatch?.[1]?.trim()) {
    lines.push(`User likes: ${likeMatch[1].trim()}`);
  }

  const workMatch = normalized.match(/\bi work (?:at|for)\s+(.+?)(?:[.!?]|$)/i);
  if (workMatch?.[1]?.trim()) {
    lines.push(`User workplace: ${workMatch[1].trim()}`);
  }

  return Array.from(new Set(lines.map((line) => line.trim()).filter((line) => line.length > 0)));
};

const buildZohoTitle = (
  sourceType: VectorUpsertDTO['sourceType'],
  payload: Record<string, unknown>,
): string => {
  switch (sourceType) {
    case 'zoho_lead':
      return pickFirst(payload, ['Full_Name', 'Lead_Name', 'Company', 'Email']) ?? 'Zoho lead';
    case 'zoho_contact':
      return (
        pickFirst(payload, ['Full_Name', 'Contact_Name', 'Email', 'Account_Name']) ?? 'Zoho contact'
      );
    case 'zoho_account':
      return pickFirst(payload, ['Account_Name', 'Company', 'Website']) ?? 'Zoho account';
    case 'zoho_deal':
      return pickFirst(payload, ['Deal_Name', 'Subject', 'Account_Name']) ?? 'Zoho deal';
    case 'zoho_ticket':
      return pickFirst(payload, ['Ticket_Title', 'Subject', 'Contact_Name']) ?? 'Zoho ticket';
    default:
      return 'Zoho record';
  }
};

const buildZohoLines = (
  sourceType: VectorUpsertDTO['sourceType'],
  payload: Record<string, unknown>,
): string[] => {
  const keysByType: Record<string, string[]> = {
    zoho_lead: [
      'Full_Name',
      'First_Name',
      'Last_Name',
      'Email',
      'Phone',
      'Mobile',
      'Company',
      'Lead_Status',
      'Owner',
      'Description',
      'Notes',
      'City',
      'State',
      'Country',
      'Created_Time',
      'Modified_Time',
    ],
    zoho_contact: [
      'Full_Name',
      'Contact_Name',
      'Email',
      'Phone',
      'Mobile',
      'Account_Name',
      'Owner',
      'Description',
      'Notes',
      'City',
      'State',
      'Country',
      'Created_Time',
      'Modified_Time',
    ],
    zoho_account: [
      'Account_Name',
      'Website',
      'Industry',
      'Phone',
      'Owner',
      'Description',
      'Notes',
      'City',
      'State',
      'Country',
      'Created_Time',
      'Modified_Time',
    ],
    zoho_deal: [
      'Deal_Name',
      'Stage',
      'Amount',
      'Account_Name',
      'Contact_Name',
      'Owner',
      'Description',
      'Notes',
      'Created_Time',
      'Modified_Time',
    ],
    zoho_ticket: [
      'Ticket_Title',
      'Subject',
      'Description',
      'Status',
      'Priority',
      'Contact_Name',
      'Owner',
      'Created_Time',
      'Modified_Time',
    ],
  };

  return (keysByType[sourceType] ?? Object.keys(payload))
    .map((key) => describeValue(key, payload[key]))
    .filter((line): line is string => Boolean(line));
};

export const buildCanonicalZohoChunks = (input: {
  sourceType: Extract<
    VectorUpsertDTO['sourceType'],
    'zoho_lead' | 'zoho_contact' | 'zoho_account' | 'zoho_deal' | 'zoho_ticket'
  >;
  sourceId: string;
  payload: Record<string, unknown>;
  companyId: string;
  visibility?: VectorUpsertDTO['visibility'];
  relationEmails?: string[];
  connectionId?: string;
}): CanonicalRetrievalChunk[] => {
  const title = buildZohoTitle(input.sourceType, input.payload);
  const documentKey = `${input.companyId}:${input.sourceType}:${input.sourceId}`;
  const sourceUpdatedAt =
    pickFirst(input.payload, ['Modified_Time', 'Updated_Time', 'modifiedAt', 'updatedAt']) ??
    undefined;
  const body = [
    `Record type: ${input.sourceType.replace('zoho_', '').replace(/_/g, ' ')}.`,
    `Record title: ${title}.`,
    ...buildZohoLines(input.sourceType, input.payload),
  ].join('\n');

  const chunks = chunkContent(body, 'zoho');
  return chunks.map((content, chunkIndex) => ({
    id: stableHash(
      `${input.companyId}|${input.sourceType}|${input.sourceId}|${chunkIndex}|${content}`,
    ),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    chunkIndex,
    documentKey,
    title,
    chunkText: content,
    chunkTokenCount: estimateTokenCount(content),
    sourceUpdatedAt,
    visibility: input.visibility ?? 'shared',
    relationEmails: input.relationEmails,
    retrievalProfile: 'zoho',
    embeddingSchemaVersion: ACTIVE_EMBEDDING_SCHEMA_VERSION,
    payload: {
      ...input.payload,
      documentKey,
      title,
      chunkText: content,
      text: content,
      citationTitle: title,
      recordType: input.sourceType,
      relationEmails: input.relationEmails ?? [],
      embeddingSchemaVersion: ACTIVE_EMBEDDING_SCHEMA_VERSION,
      retrievalProfile: 'zoho',
      connectionId: input.connectionId,
      sourceUpdatedAt,
    },
  }));
};

export const buildCanonicalFileChunks = (input: {
  companyId: string;
  fileAssetId: string;
  fileName: string;
  mimeType: string;
  sourceUrl: string;
  uploaderUserId: string;
  visibility?: VectorUpsertDTO['visibility'];
  allowedRoles?: string[];
  text: string;
  metadata?: Record<string, unknown>;
}): CanonicalRetrievalChunk[] => {
  const title = input.fileName;
  const documentKey = `${input.companyId}:file_document:${input.fileAssetId}`;
  const chunks = chunkContent(input.text, 'file');
  return chunks.map((content, chunkIndex) => ({
    id: stableHash(
      `${input.companyId}|file_document|${input.fileAssetId}|${chunkIndex}|${content}`,
    ),
    sourceType: 'file_document',
    sourceId: input.fileAssetId,
    chunkIndex,
    documentKey,
    title,
    chunkText: content,
    chunkTokenCount: estimateTokenCount(content),
    sourceUpdatedAt: new Date().toISOString(),
    visibility: input.visibility ?? 'shared',
    allowedRoles: input.allowedRoles,
    ownerUserId: input.uploaderUserId,
    fileAssetId: input.fileAssetId,
    retrievalProfile: 'file',
    embeddingSchemaVersion: ACTIVE_EMBEDDING_SCHEMA_VERSION,
    payload: {
      citationType: 'file',
      citationTitle: title,
      fileName: input.fileName,
      mimeType: input.mimeType,
      cloudinaryUrl: input.sourceUrl,
      sourceUrl: input.sourceUrl,
      fileAssetId: input.fileAssetId,
      documentKey,
      allowedRoles: input.allowedRoles ?? [],
      title,
      chunkText: content,
      text: content,
      modality: input.mimeType.startsWith('image/')
        ? 'image'
        : input.mimeType.startsWith('video/')
          ? 'video'
          : 'text',
      embeddingSchemaVersion: ACTIVE_EMBEDDING_SCHEMA_VERSION,
      retrievalProfile: 'file',
      sourceUpdatedAt: new Date().toISOString(),
      ...(input.metadata ?? {}),
    },
  }));
};

export const buildCanonicalChatChunks = (input: {
  companyId: string;
  sourceId: string;
  requesterUserId: string;
  conversationKey: string;
  role: 'user' | 'assistant';
  channel: string;
  chatId: string;
  text: string;
  visibility?: VectorUpsertDTO['visibility'];
}): CanonicalRetrievalChunk[] => {
  const title = `${input.role} chat turn`;
  const documentKey = `${input.companyId}:chat_turn:${input.sourceId}`;
  const chunks = chunkContent(input.text, 'chat');
  const baseChunks = chunks.map((content, chunkIndex) => ({
    id: stableHash(`${input.companyId}|chat_turn|${input.sourceId}|${chunkIndex}|${content}`),
    sourceType: 'chat_turn',
    sourceId: input.sourceId,
    chunkIndex,
    documentKey,
    title,
    chunkText: content,
    chunkTokenCount: estimateTokenCount(content),
    sourceUpdatedAt: new Date().toISOString(),
    visibility: input.visibility ?? 'personal',
    conversationKey: input.conversationKey,
    ownerUserId: input.requesterUserId,
    retrievalProfile: 'chat',
    embeddingSchemaVersion: ACTIVE_EMBEDDING_SCHEMA_VERSION,
    payload: {
      role: input.role,
      documentKey,
      chunkText: content,
      text: content,
      fullText: input.text,
      channel: input.channel,
      chatId: input.chatId,
      conversationKey: input.conversationKey,
      title,
      citationTitle: title,
      embeddingSchemaVersion: ACTIVE_EMBEDDING_SCHEMA_VERSION,
      retrievalProfile: 'chat',
      sourceUpdatedAt: new Date().toISOString(),
    },
  }));

  if (input.role !== 'user') {
    return baseChunks;
  }

  const profileLines = extractProfileMemoryLines(input.text);
  const profileChunks = profileLines.map((content, index) => ({
    id: stableHash(`${input.companyId}|chat_turn|${input.sourceId}|profile|${index}|${content}`),
    sourceType: 'chat_turn' as const,
    sourceId: input.sourceId,
    chunkIndex: baseChunks.length + index,
    documentKey: `${documentKey}:profile`,
    title: 'user profile memory',
    chunkText: content,
    chunkTokenCount: estimateTokenCount(content),
    sourceUpdatedAt: new Date().toISOString(),
    visibility: input.visibility ?? 'personal',
    conversationKey: input.conversationKey,
    ownerUserId: input.requesterUserId,
    retrievalProfile: 'chat' as const,
    embeddingSchemaVersion: ACTIVE_EMBEDDING_SCHEMA_VERSION,
    payload: {
      role: input.role,
      documentKey: `${documentKey}:profile`,
      chunkText: content,
      text: content,
      fullText: input.text,
      channel: input.channel,
      chatId: input.chatId,
      conversationKey: input.conversationKey,
      title: 'user profile memory',
      citationTitle: 'user profile memory',
      memoryKind: 'user_profile_fact',
      embeddingSchemaVersion: ACTIVE_EMBEDDING_SCHEMA_VERSION,
      retrievalProfile: 'chat',
      sourceUpdatedAt: new Date().toISOString(),
    },
  }));

  return [...baseChunks, ...profileChunks];
};
