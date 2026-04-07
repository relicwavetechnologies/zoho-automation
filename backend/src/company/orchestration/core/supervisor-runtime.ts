import type { NormalizedIncomingMessageDTO, OrchestrationTaskDTO } from '../../contracts';
import type { OrchestrationExecutionInput } from '../engine/types';
import { supervisorV2Engine } from '../engine/supervisor-v2.engine';
import { DesktopOrchestrationUpdateAdapter } from './adapters/desktop-update.adapter';
import { LarkOrchestrationUpdateAdapter } from './adapters/lark-update.adapter';
import type { OrchestrationUpdateAdapter } from './update-adapter';

const resolveDefaultUpdateAdapter = (
  task: OrchestrationTaskDTO,
  message: NormalizedIncomingMessageDTO,
): OrchestrationUpdateAdapter =>
  message.channel === 'lark'
    ? new LarkOrchestrationUpdateAdapter({
        task,
        message,
        initialStatusMessageId:
          message.trace?.statusMessageId
          ?? message.trace?.ackMessageId
          ?? undefined,
      })
    : new DesktopOrchestrationUpdateAdapter();

export const executeSharedSupervisorTask = async (
  input: OrchestrationExecutionInput,
) => supervisorV2Engine.executeTask({
  ...input,
  updateAdapter: input.updateAdapter ?? resolveDefaultUpdateAdapter(input.task, input.message),
});
