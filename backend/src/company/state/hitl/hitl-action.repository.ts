import type { HITLActionDTO, HitlActionStatus } from '../../contracts';
import { redisConnection } from '../../queue/runtime/redis.connection';

const actionKey = (actionId: string) => `company:hitl:action:${actionId}`;
const taskActionKey = (taskId: string) => `company:task:${taskId}:hitl:action`;

type StoredHitlAction = HITLActionDTO & {
  _chatId?: string;
  _threadId?: string;
  _executionId?: string;
  _channel?: string;
  _payloadJson?: string;
  _metadataJson?: string;
  _resolvedAt?: string;
};

export type HydratedStoredHitlAction = StoredHitlAction & {
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

const parseStoredAction = (stored: Record<string, string>): StoredHitlAction | null => {
  if (!stored.actionId) {
    return null;
  }
  return {
    taskId: stored.taskId,
    actionId: stored.actionId,
    actionType: stored.actionType as HITLActionDTO['actionType'],
    summary: stored.summary,
    toolId: stored.toolId,
    actionGroup: stored.actionGroup as HITLActionDTO['actionGroup'],
    channel: stored.channel as HITLActionDTO['channel'],
    subject: stored.subject,
    requestedAt: stored.requestedAt,
    expiresAt: stored.expiresAt,
    status: stored.status as HitlActionStatus,
    _chatId: stored._chatId,
    _threadId: stored._threadId,
    _executionId: stored._executionId,
    _channel: stored._channel,
    _payloadJson: stored._payloadJson,
    _metadataJson: stored._metadataJson,
    _resolvedAt: stored._resolvedAt,
  };
};

class HitlActionRepository {
  async createPending(
    action: HITLActionDTO,
    input: {
      chatId: string;
      threadId?: string;
      executionId?: string;
      channel?: 'desktop' | 'lark';
      payload?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const redis = redisConnection.getClient();
    const key = actionKey(action.actionId);
    await redis
      .multi()
      .hset(key, {
        taskId: action.taskId,
        actionId: action.actionId,
        actionType: action.actionType,
        summary: action.summary,
        toolId: action.toolId ?? '',
        actionGroup: action.actionGroup ?? '',
        channel: action.channel ?? input.channel ?? '',
        subject: action.subject ?? '',
        requestedAt: action.requestedAt,
        expiresAt: action.expiresAt,
        status: action.status,
        _chatId: input.chatId,
        _threadId: input.threadId ?? '',
        _executionId: input.executionId ?? '',
        _channel: input.channel ?? '',
        _payloadJson: input.payload ? JSON.stringify(input.payload) : '',
        _metadataJson: input.metadata ? JSON.stringify(input.metadata) : '',
      })
      .set(taskActionKey(action.taskId), action.actionId)
      .expire(key, 60 * 60 * 24)
      .exec();
  }

  async getByActionId(actionId: string): Promise<StoredHitlAction | null> {
    const redis = redisConnection.getClient();
    const stored = await redis.hgetall(actionKey(actionId));
    return parseStoredAction(stored);
  }

  async getHydratedByActionId(actionId: string): Promise<HydratedStoredHitlAction | null> {
    const stored = await this.getByActionId(actionId);
    if (!stored) {
      return null;
    }

    const parseJsonRecord = (value?: string): Record<string, unknown> | undefined => {
      if (!value) return undefined;
      try {
        const parsed = JSON.parse(value) as unknown;
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : undefined;
      } catch {
        return undefined;
      }
    };

    return {
      ...stored,
      payload: parseJsonRecord(stored._payloadJson),
      metadata: parseJsonRecord(stored._metadataJson),
    };
  }

  async getByTaskId(taskId: string): Promise<StoredHitlAction | null> {
    const redis = redisConnection.getClient();
    const id = await redis.get(taskActionKey(taskId));
    if (!id) {
      return null;
    }
    return this.getByActionId(id);
  }

  async resolve(actionId: string, decision: 'confirmed' | 'cancelled' | 'expired'): Promise<boolean> {
    const redis = redisConnection.getClient();
    const key = actionKey(actionId);
    const now = new Date().toISOString();

    const result = await redis.eval(
      `
      local current = redis.call('HGET', KEYS[1], 'status')
      if not current then
        return -1
      end
      if current ~= 'pending' then
        return 0
      end
      redis.call('HSET', KEYS[1], 'status', ARGV[1], '_resolvedAt', ARGV[2])
      return 1
      `,
      1,
      key,
      decision,
      now,
    );

    return Number(result) === 1;
  }
}

export const hitlActionRepository = new HitlActionRepository();
