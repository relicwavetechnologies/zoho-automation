import { redisConnection } from './redis.connection';
import { logger } from '../../../utils/logger';

const ORCHESTRATION_DLQ_KEY = 'company:orchestration:dlq';
const ORCHESTRATION_DLQ_MAX_ITEMS = 500;

export type DeadLetterRecord = {
  queue: 'orchestration';
  failedAt: string;
  taskId?: string;
  jobId?: string;
  requestId?: string;
  companyId?: string;
  channel?: string;
  messageId?: string;
  chatId?: string;
  userId?: string;
  error: {
    message: string;
    code?: string;
  };
};

export const pushDeadLetterRecord = async (record: DeadLetterRecord): Promise<void> => {
  try {
    const redis = redisConnection.getClient();
    await redis
      .multi()
      .lpush(ORCHESTRATION_DLQ_KEY, JSON.stringify(record))
      .ltrim(ORCHESTRATION_DLQ_KEY, 0, ORCHESTRATION_DLQ_MAX_ITEMS - 1)
      .exec();
  } catch (error) {
    logger.warn('queue.dead_letter.store_failed', {
      queue: record.queue,
      taskId: record.taskId,
      error: error instanceof Error ? error.message : 'unknown_dead_letter_store_error',
    });
  }
};
