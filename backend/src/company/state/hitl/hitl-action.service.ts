import { randomUUID } from 'crypto';

import config from '../../../config';
import type { HITLActionDTO } from '../../contracts';
import { hitlActionRepository } from './hitl-action.repository';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

type WaitResult = {
  action: HITLActionDTO;
  chatId?: string;
};

class HitlActionService {
  async createPending(input: {
    taskId: string;
    actionType: HITLActionDTO['actionType'];
    summary: string;
    chatId: string;
  }): Promise<HITLActionDTO> {
    const now = new Date();
    const action: HITLActionDTO = {
      taskId: input.taskId,
      actionId: randomUUID(),
      actionType: input.actionType,
      summary: input.summary,
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + config.HITL_TIMEOUT_SECONDS * 1000).toISOString(),
      status: 'pending',
    };
    await hitlActionRepository.createPending(action, input.chatId);
    return action;
  }

  async resolveByActionId(actionId: string, decision: 'confirmed' | 'cancelled'): Promise<boolean> {
    return hitlActionRepository.resolve(actionId, decision);
  }

  async waitForResolution(actionId: string): Promise<WaitResult> {
    for (;;) {
      const action = await hitlActionRepository.getByActionId(actionId);
      if (!action) {
        throw new Error('HITL action not found');
      }

      if (action.status === 'pending') {
        if (new Date(action.expiresAt).getTime() <= Date.now()) {
          await hitlActionRepository.resolve(actionId, 'expired');
        } else {
          await sleep(500);
        }
        continue;
      }

      return {
        action: {
          taskId: action.taskId,
          actionId: action.actionId,
          actionType: action.actionType,
          summary: action.summary,
          requestedAt: action.requestedAt,
          expiresAt: action.expiresAt,
          status: action.status,
        },
        chatId: action._chatId,
      };
    }
  }
}

export const hitlActionService = new HitlActionService();
