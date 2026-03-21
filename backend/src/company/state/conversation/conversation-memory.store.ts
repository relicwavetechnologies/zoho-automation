type ConversationRole = 'user' | 'assistant';

type ConversationTurn = {
  role: ConversationRole;
  content: string;
  createdAtMs: number;
  dedupeKey?: string;
};

type ConversationBucket = {
  turns: ConversationTurn[];
  larkDocs: LarkDocReference[];
  larkCalendarEvents: LarkCalendarEventReference[];
  larkTasks: LarkTaskReference[];
  fileAssets: FileAssetReference[];
  updatedAtMs: number;
};

type ConversationMessage = {
  role: ConversationRole;
  content: string;
};

export type LarkDocReference = {
  title: string;
  documentId: string;
  url?: string;
  updatedAtMs: number;
};

export type LarkCalendarEventReference = {
  eventId: string;
  calendarId?: string;
  summary?: string;
  startTime?: string;
  endTime?: string;
  url?: string;
  updatedAtMs: number;
};

export type LarkTaskReference = {
  taskId: string;
  taskGuid?: string;
  summary?: string;
  status?: string;
  url?: string;
  updatedAtMs: number;
};

export type FileAssetReference = {
  fileAssetId: string;
  fileName: string;
  mimeType?: string;
  cloudinaryUrl?: string;
  ingestionStatus?: string;
  updatedAtMs: number;
};

const DEFAULT_MAX_TURNS_PER_CHAT = 30;
const DEFAULT_MAX_CONTEXT_MESSAGES = 14;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

const normalizeContent = (value: string): string => value.trim();

class ConversationMemoryStore {
  private readonly buckets = new Map<string, ConversationBucket>();
  private readonly maxTurnsPerChat: number;
  private readonly maxContextMessages: number;
  private readonly ttlMs: number;

  constructor(input?: {
    maxTurnsPerChat?: number;
    maxContextMessages?: number;
    ttlMs?: number;
  }) {
    this.maxTurnsPerChat = Math.max(2, input?.maxTurnsPerChat ?? DEFAULT_MAX_TURNS_PER_CHAT);
    this.maxContextMessages = Math.max(1, input?.maxContextMessages ?? DEFAULT_MAX_CONTEXT_MESSAGES);
    this.ttlMs = Math.max(60_000, input?.ttlMs ?? DEFAULT_TTL_MS);
  }

  private pruneExpired(nowMs = Date.now()): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (nowMs - bucket.updatedAtMs > this.ttlMs) {
        this.buckets.delete(key);
      }
    }
  }

  private getOrCreateBucket(conversationKey: string, nowMs = Date.now()): ConversationBucket {
    this.pruneExpired(nowMs);
    const existing = this.buckets.get(conversationKey);
    if (existing) {
      existing.updatedAtMs = nowMs;
      return existing;
    }

    const created: ConversationBucket = {
      turns: [],
      larkDocs: [],
      larkCalendarEvents: [],
      larkTasks: [],
      fileAssets: [],
      updatedAtMs: nowMs,
    };
    this.buckets.set(conversationKey, created);
    return created;
  }

  private appendTurn(
    conversationKey: string,
    turn: Omit<ConversationTurn, 'createdAtMs'>,
    nowMs = Date.now(),
  ): void {
    const bucket = this.getOrCreateBucket(conversationKey, nowMs);
    const content = normalizeContent(turn.content);
    if (!content) {
      return;
    }

    if (turn.dedupeKey) {
      const exists = bucket.turns.some((entry) => entry.dedupeKey === turn.dedupeKey);
      if (exists) {
        return;
      }
    }

    bucket.turns.push({
      role: turn.role,
      content,
      createdAtMs: nowMs,
      dedupeKey: turn.dedupeKey,
    });

    if (bucket.turns.length > this.maxTurnsPerChat) {
      bucket.turns.splice(0, bucket.turns.length - this.maxTurnsPerChat);
    }

    bucket.updatedAtMs = nowMs;
  }

  addUserMessage(conversationKey: string, messageId: string, content: string): void {
    this.appendTurn(conversationKey, {
      role: 'user',
      content,
      dedupeKey: `user:${messageId}`,
    });
  }

  addAssistantMessage(conversationKey: string, taskId: string, content: string): void {
    this.appendTurn(conversationKey, {
      role: 'assistant',
      content,
      dedupeKey: `assistant:${taskId}`,
    });
  }

  addLarkDoc(conversationKey: string, input: {
    title: string;
    documentId: string;
    url?: string;
  }): void {
    const nowMs = Date.now();
    const bucket = this.getOrCreateBucket(conversationKey, nowMs);
    const existingIndex = bucket.larkDocs.findIndex((entry) => entry.documentId === input.documentId);
    const next: LarkDocReference = {
      title: input.title.trim() || 'Lark Doc',
      documentId: input.documentId,
      url: input.url?.trim() || undefined,
      updatedAtMs: nowMs,
    };

    if (existingIndex >= 0) {
      bucket.larkDocs.splice(existingIndex, 1);
    }
    bucket.larkDocs.push(next);
    if (bucket.larkDocs.length > 12) {
      bucket.larkDocs.splice(0, bucket.larkDocs.length - 12);
    }
    bucket.updatedAtMs = nowMs;
  }

  addLarkCalendarEvent(conversationKey: string, input: {
    eventId: string;
    calendarId?: string;
    summary?: string;
    startTime?: string;
    endTime?: string;
    url?: string;
  }): void {
    const nowMs = Date.now();
    const bucket = this.getOrCreateBucket(conversationKey, nowMs);
    const existingIndex = bucket.larkCalendarEvents.findIndex((entry) => entry.eventId === input.eventId);
    const next: LarkCalendarEventReference = {
      eventId: input.eventId,
      calendarId: input.calendarId?.trim() || undefined,
      summary: input.summary?.trim() || undefined,
      startTime: input.startTime?.trim() || undefined,
      endTime: input.endTime?.trim() || undefined,
      url: input.url?.trim() || undefined,
      updatedAtMs: nowMs,
    };

    if (existingIndex >= 0) {
      bucket.larkCalendarEvents.splice(existingIndex, 1);
    }
    bucket.larkCalendarEvents.push(next);
    if (bucket.larkCalendarEvents.length > 24) {
      bucket.larkCalendarEvents.splice(0, bucket.larkCalendarEvents.length - 24);
    }
    bucket.updatedAtMs = nowMs;
  }

  getLatestLarkCalendarEvent(conversationKey: string): LarkCalendarEventReference | null {
    this.pruneExpired();
    const bucket = this.buckets.get(conversationKey);
    if (!bucket || bucket.larkCalendarEvents.length === 0) {
      return null;
    }
    return bucket.larkCalendarEvents[bucket.larkCalendarEvents.length - 1] ?? null;
  }

  listLarkCalendarEvents(conversationKey: string): LarkCalendarEventReference[] {
    this.pruneExpired();
    const bucket = this.buckets.get(conversationKey);
    return bucket ? [...bucket.larkCalendarEvents] : [];
  }

  addLarkTask(conversationKey: string, input: {
    taskId: string;
    taskGuid?: string;
    summary?: string;
    status?: string;
    url?: string;
  }): void {
    const nowMs = Date.now();
    const bucket = this.getOrCreateBucket(conversationKey, nowMs);
    const existingIndex = bucket.larkTasks.findIndex((entry) =>
      entry.taskGuid === input.taskGuid
      || entry.taskId === input.taskId);
    const next: LarkTaskReference = {
      taskId: input.taskId,
      taskGuid: input.taskGuid?.trim() || undefined,
      summary: input.summary?.trim() || undefined,
      status: input.status?.trim() || undefined,
      url: input.url?.trim() || undefined,
      updatedAtMs: nowMs,
    };

    if (existingIndex >= 0) {
      bucket.larkTasks.splice(existingIndex, 1);
    }
    bucket.larkTasks.push(next);
    if (bucket.larkTasks.length > 24) {
      bucket.larkTasks.splice(0, bucket.larkTasks.length - 24);
    }
    bucket.updatedAtMs = nowMs;
  }

  getLatestLarkTask(conversationKey: string): LarkTaskReference | null {
    this.pruneExpired();
    const bucket = this.buckets.get(conversationKey);
    if (!bucket || bucket.larkTasks.length === 0) {
      return null;
    }
    return bucket.larkTasks[bucket.larkTasks.length - 1] ?? null;
  }

  listLarkTasks(conversationKey: string): LarkTaskReference[] {
    this.pruneExpired();
    const bucket = this.buckets.get(conversationKey);
    return bucket ? [...bucket.larkTasks] : [];
  }

  addFileAsset(conversationKey: string, input: {
    fileAssetId: string;
    fileName: string;
    mimeType?: string;
    cloudinaryUrl?: string;
    ingestionStatus?: string;
  }): void {
    const nowMs = Date.now();
    const bucket = this.getOrCreateBucket(conversationKey, nowMs);
    const existingIndex = bucket.fileAssets.findIndex((entry) => entry.fileAssetId === input.fileAssetId);
    const next: FileAssetReference = {
      fileAssetId: input.fileAssetId,
      fileName: input.fileName.trim() || 'file',
      mimeType: input.mimeType?.trim() || undefined,
      cloudinaryUrl: input.cloudinaryUrl?.trim() || undefined,
      ingestionStatus: input.ingestionStatus?.trim() || undefined,
      updatedAtMs: nowMs,
    };

    if (existingIndex >= 0) {
      bucket.fileAssets.splice(existingIndex, 1);
    }
    bucket.fileAssets.push(next);
    if (bucket.fileAssets.length > 24) {
      bucket.fileAssets.splice(0, bucket.fileAssets.length - 24);
    }
    bucket.updatedAtMs = nowMs;
  }

  getLatestFileAsset(conversationKey: string): FileAssetReference | null {
    this.pruneExpired();
    const bucket = this.buckets.get(conversationKey);
    if (!bucket || bucket.fileAssets.length === 0) {
      return null;
    }
    return bucket.fileAssets[bucket.fileAssets.length - 1] ?? null;
  }

  listFileAssets(conversationKey: string): FileAssetReference[] {
    this.pruneExpired();
    const bucket = this.buckets.get(conversationKey);
    return bucket ? [...bucket.fileAssets] : [];
  }

  getLatestLarkDoc(conversationKey: string): LarkDocReference | null {
    this.pruneExpired();
    const bucket = this.buckets.get(conversationKey);
    if (!bucket || bucket.larkDocs.length === 0) {
      return null;
    }
    return bucket.larkDocs[bucket.larkDocs.length - 1] ?? null;
  }

  listLarkDocs(conversationKey: string): LarkDocReference[] {
    this.pruneExpired();
    const bucket = this.buckets.get(conversationKey);
    return bucket ? [...bucket.larkDocs] : [];
  }

  getContextMessages(conversationKey: string, maxMessages = this.maxContextMessages): ConversationMessage[] {
    this.pruneExpired();
    const bucket = this.buckets.get(conversationKey);
    if (!bucket || bucket.turns.length === 0) {
      return [];
    }

    const capped = Math.max(1, Math.min(this.maxContextMessages, maxMessages));
    const turns = bucket.turns.slice(-capped);
    return turns.map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));
  }

  clearConversation(conversationKey: string): void {
    this.buckets.delete(conversationKey);
  }
}

export const conversationMemoryStore = new ConversationMemoryStore();
