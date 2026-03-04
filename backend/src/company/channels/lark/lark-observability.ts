import { createHash } from 'crypto';

type LarkTraceMetaInput = {
  requestId?: string;
  channel?: string;
  eventId?: string;
  messageId?: string;
  chatId?: string;
  userId?: string;
  taskId?: string;
  jobId?: string;
  idempotencyKey?: string;
  keyType?: 'event' | 'message';
  textHash?: string;
  receivedAt?: string;
};

export const buildLarkTextHash = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

export const buildLarkTraceMeta = (input: LarkTraceMetaInput): Record<string, unknown> => {
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      meta[key] = value;
    }
  }
  return meta;
};
