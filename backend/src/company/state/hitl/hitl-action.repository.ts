import type { HITLActionDTO, HitlActionStatus } from '../../contracts';
import { redisConnection } from '../../queue/runtime/redis.connection';

const actionKey = (actionId: string) => `emiac:hitl:action:${actionId}`;
const taskActionKey = (taskId: string) => `emiac:task:${taskId}:hitl:action`;

type StoredHitlAction = HITLActionDTO & {
  _chatId?: string;
  _resolvedAt?: string;
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
    requestedAt: stored.requestedAt,
    expiresAt: stored.expiresAt,
    status: stored.status as HitlActionStatus,
    _chatId: stored._chatId,
    _resolvedAt: stored._resolvedAt,
  };
};

class HitlActionRepository {
  async createPending(action: HITLActionDTO, chatId: string): Promise<void> {
    const redis = redisConnection.getClient();
    const key = actionKey(action.actionId);
    await redis
      .multi()
      .hset(key, {
        taskId: action.taskId,
        actionId: action.actionId,
        actionType: action.actionType,
        summary: action.summary,
        requestedAt: action.requestedAt,
        expiresAt: action.expiresAt,
        status: action.status,
        _chatId: chatId,
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
