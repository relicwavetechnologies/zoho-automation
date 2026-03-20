import type { ModelMessage } from 'ai';

import { conversationMemoryStore } from '../../../../state/conversation/conversation-memory.store';
import { desktopThreadsService } from '../../../../../modules/desktop-threads/desktop-threads.service';
import type { MemberSessionDTO } from '../../../../../modules/member-auth/member-auth.service';
import type { AttachedFileRef } from '../../../../../modules/desktop-chat/file-vision.builder';

type PersistedConversationRefs = {
  latestLarkDoc?: Record<string, unknown>;
  latestLarkCalendarEvent?: Record<string, unknown>;
  latestLarkTask?: Record<string, unknown>;
};

export type DesktopThreadHistorySnapshot = Awaited<ReturnType<typeof desktopThreadsService.getThread>>;

export const buildDesktopConversationKey = (threadId: string): string => `desktop:${threadId}`;

const asAttachedFile = (value: unknown): AttachedFileRef | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fileAssetId = typeof record.fileAssetId === 'string' ? record.fileAssetId.trim() : '';
  const cloudinaryUrl = typeof record.cloudinaryUrl === 'string' ? record.cloudinaryUrl.trim() : '';
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType.trim() : '';
  const fileName = typeof record.fileName === 'string' ? record.fileName.trim() : '';
  if (!fileAssetId || !cloudinaryUrl || !mimeType || !fileName) {
    return null;
  }
  return {
    fileAssetId,
    cloudinaryUrl,
    mimeType,
    fileName,
  };
};

export const buildPersistedConversationRefs = (conversationKey: string): PersistedConversationRefs | null => {
  const latestDoc = conversationMemoryStore.getLatestLarkDoc(conversationKey);
  const latestEvent = conversationMemoryStore.getLatestLarkCalendarEvent(conversationKey);
  const latestTask = conversationMemoryStore.getLatestLarkTask(conversationKey);

  const refs: PersistedConversationRefs = {
    ...(latestDoc ? {
      latestLarkDoc: {
        title: latestDoc.title,
        documentId: latestDoc.documentId,
        ...(latestDoc.url ? { url: latestDoc.url } : {}),
      },
    } : {}),
    ...(latestEvent ? {
      latestLarkCalendarEvent: {
        eventId: latestEvent.eventId,
        ...(latestEvent.calendarId ? { calendarId: latestEvent.calendarId } : {}),
        ...(latestEvent.summary ? { summary: latestEvent.summary } : {}),
        ...(latestEvent.startTime ? { startTime: latestEvent.startTime } : {}),
        ...(latestEvent.endTime ? { endTime: latestEvent.endTime } : {}),
        ...(latestEvent.url ? { url: latestEvent.url } : {}),
      },
    } : {}),
    ...(latestTask ? {
      latestLarkTask: {
        taskId: latestTask.taskId,
        ...(latestTask.taskGuid ? { taskGuid: latestTask.taskGuid } : {}),
        ...(latestTask.summary ? { summary: latestTask.summary } : {}),
        ...(latestTask.status ? { status: latestTask.status } : {}),
        ...(latestTask.url ? { url: latestTask.url } : {}),
      },
    } : {}),
  };

  return Object.keys(refs).length > 0 ? refs : null;
};

const hydrateConversationRefsFromMetadata = (conversationKey: string, metadata: Record<string, unknown>): void => {
  const refs = metadata.conversationRefs;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return;
  const record = refs as PersistedConversationRefs;

  const latestDoc = record.latestLarkDoc;
  if (latestDoc && typeof latestDoc === 'object' && !Array.isArray(latestDoc)) {
    const documentId = typeof latestDoc.documentId === 'string' ? latestDoc.documentId.trim() : '';
    if (documentId) {
      conversationMemoryStore.addLarkDoc(conversationKey, {
        title: typeof latestDoc.title === 'string' ? latestDoc.title : 'Lark Doc',
        documentId,
        url: typeof latestDoc.url === 'string' ? latestDoc.url : undefined,
      });
    }
  }

  const latestEvent = record.latestLarkCalendarEvent;
  if (latestEvent && typeof latestEvent === 'object' && !Array.isArray(latestEvent)) {
    const eventId = typeof latestEvent.eventId === 'string' ? latestEvent.eventId.trim() : '';
    if (eventId) {
      conversationMemoryStore.addLarkCalendarEvent(conversationKey, {
        eventId,
        calendarId: typeof latestEvent.calendarId === 'string' ? latestEvent.calendarId : undefined,
        summary: typeof latestEvent.summary === 'string' ? latestEvent.summary : undefined,
        startTime: typeof latestEvent.startTime === 'string' ? latestEvent.startTime : undefined,
        endTime: typeof latestEvent.endTime === 'string' ? latestEvent.endTime : undefined,
        url: typeof latestEvent.url === 'string' ? latestEvent.url : undefined,
      });
    }
  }

  const latestTask = record.latestLarkTask;
  if (latestTask && typeof latestTask === 'object' && !Array.isArray(latestTask)) {
    const taskId = typeof latestTask.taskId === 'string' ? latestTask.taskId.trim() : '';
    if (taskId) {
      conversationMemoryStore.addLarkTask(conversationKey, {
        taskId,
        taskGuid: typeof latestTask.taskGuid === 'string' ? latestTask.taskGuid : undefined,
        summary: typeof latestTask.summary === 'string' ? latestTask.summary : undefined,
        status: typeof latestTask.status === 'string' ? latestTask.status : undefined,
        url: typeof latestTask.url === 'string' ? latestTask.url : undefined,
      });
    }
  }
};

export const buildDesktopConversationRefsContext = (conversationKey: string): string | null => {
  const latestDoc = conversationMemoryStore.getLatestLarkDoc(conversationKey);
  const latestEvent = conversationMemoryStore.getLatestLarkCalendarEvent(conversationKey);
  const latestTask = conversationMemoryStore.getLatestLarkTask(conversationKey);
  const lines: string[] = [];

  if (latestTask) {
    lines.push(`Latest Lark task: ${latestTask.summary ?? latestTask.taskId} [taskId=${latestTask.taskId}${latestTask.taskGuid ? `, taskGuid=${latestTask.taskGuid}` : ''}${latestTask.status ? `, status=${latestTask.status}` : ''}]`);
  }
  if (latestDoc) {
    lines.push(`Latest Lark doc: ${latestDoc.title} [documentId=${latestDoc.documentId}]`);
  }
  if (latestEvent) {
    lines.push(`Latest Lark event: ${latestEvent.summary ?? latestEvent.eventId} [eventId=${latestEvent.eventId}]`);
  }

  return lines.length > 0 ? ['Conversation refs:', ...lines].join('\n') : null;
};

export const hydrateDesktopThreadState = async (
  threadId: string,
  session: MemberSessionDTO,
): Promise<DesktopThreadHistorySnapshot> => {
  const history = await desktopThreadsService.getThread(threadId, session.userId);
  const conversationKey = buildDesktopConversationKey(threadId);

  for (const message of history.messages.slice(-20)) {
    if (message.role === 'user') {
      conversationMemoryStore.addUserMessage(conversationKey, message.id, message.content);
    } else {
      conversationMemoryStore.addAssistantMessage(conversationKey, message.id, message.content);
      if (message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)) {
        hydrateConversationRefsFromMetadata(conversationKey, message.metadata as Record<string, unknown>);
      }
    }
  }

  return history;
};

const readAttachedFilesFromMetadata = (metadata: unknown): AttachedFileRef[] => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const attachedFiles = (metadata as Record<string, unknown>).attachedFiles;
  if (!Array.isArray(attachedFiles)) return [];
  return attachedFiles.flatMap((entry) => {
    const parsed = asAttachedFile(entry);
    return parsed ? [parsed] : [];
  });
};

export const collectRecentAttachedFiles = (history: DesktopThreadHistorySnapshot): AttachedFileRef[] => {
  const merged = new Map<string, AttachedFileRef>();
  for (const message of history.messages.slice(-8)) {
    const files = readAttachedFilesFromMetadata(message.metadata);
    for (const file of files) {
      if (!merged.has(file.fileAssetId)) {
        merged.set(file.fileAssetId, file);
      }
    }
  }
  return Array.from(merged.values());
};

export const mapDesktopHistoryToMessages = async (
  threadId: string,
  session: MemberSessionDTO,
): Promise<{ messages: ModelMessage[]; history: DesktopThreadHistorySnapshot }> => {
  const history = await hydrateDesktopThreadState(threadId, session);
  const messages: ModelMessage[] = [];
  for (const message of history.messages.slice(-12)) {
    messages.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    });
  }
  return { messages, history };
};
