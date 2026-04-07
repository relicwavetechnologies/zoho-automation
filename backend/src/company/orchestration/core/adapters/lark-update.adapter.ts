import { resolveChannelAdapter } from '../../../channels/channel-adapter.registry';
import type { NormalizedIncomingMessageDTO, OrchestrationTaskDTO } from '../../../contracts';
import { LarkStatusCoordinator } from '../../engine/lark-status.coordinator';
import type { OrchestrationStatusRenderable, OrchestrationUpdateAdapter } from '../update-adapter';

export class LarkOrchestrationUpdateAdapter implements OrchestrationUpdateAdapter {
  readonly channel = 'lark' as const;

  private readonly coordinator: LarkStatusCoordinator;

  constructor(input: {
    task: OrchestrationTaskDTO;
    message: NormalizedIncomingMessageDTO;
    initialStatusMessageId?: string;
  }) {
    const isScheduledRun = Boolean(input.message.trace?.isScheduledRun);
    this.coordinator = new LarkStatusCoordinator({
      adapter: resolveChannelAdapter('lark'),
      chatId: input.message.chatId,
      correlationId: input.task.taskId,
      initialStatusMessageId: input.initialStatusMessageId,
      replyToMessageId: isScheduledRun
        ? undefined
        : (input.message.trace?.replyToMessageId ?? input.message.messageId),
      replyInThread: isScheduledRun ? false : input.message.chatType === 'group',
    });
  }

  async initialize(renderable?: OrchestrationStatusRenderable): Promise<void> {
    if (!renderable) {
      return;
    }
    await this.coordinator.update(renderable, { force: true });
  }

  async update(renderable: OrchestrationStatusRenderable, options?: { force?: boolean; terminal?: boolean }): Promise<void> {
    await this.coordinator.update(renderable, options);
  }

  async updateLiveText(text: string): Promise<void> {
    await this.coordinator.updateLiveText(text);
  }

  async finalizeLiveText(text: string): Promise<void> {
    await this.coordinator.finalizeLiveText(text);
  }

  startHeartbeat(getRenderable: () => OrchestrationStatusRenderable): void {
    this.coordinator.startHeartbeat(getRenderable);
  }

  getStatusMessageId(): string | undefined {
    return this.coordinator.getStatusMessageId();
  }

  async close(): Promise<void> {
    await this.coordinator.close();
  }
}
