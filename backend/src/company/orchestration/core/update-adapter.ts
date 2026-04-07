import type { ChannelAction } from '../../channels/base/channel-adapter';

export type OrchestrationStatusRenderable = {
  text: string;
  actions?: ChannelAction[];
};

export interface OrchestrationUpdateAdapter {
  readonly channel: 'lark' | 'desktop';
  initialize?(renderable?: OrchestrationStatusRenderable): Promise<void>;
  update(renderable: OrchestrationStatusRenderable, options?: { force?: boolean; terminal?: boolean }): Promise<void>;
  updateLiveText(text: string): Promise<void>;
  finalizeLiveText(text: string): Promise<void>;
  startHeartbeat(getRenderable: () => OrchestrationStatusRenderable): void;
  getStatusMessageId(): string | undefined;
  close(): Promise<void>;
}

export class NoOpOrchestrationUpdateAdapter implements OrchestrationUpdateAdapter {
  readonly channel = 'desktop' as const;

  async initialize(): Promise<void> {}

  async update(): Promise<void> {}

  async updateLiveText(): Promise<void> {}

  async finalizeLiveText(): Promise<void> {}

  startHeartbeat(): void {}

  getStatusMessageId(): string | undefined {
    return undefined;
  }

  async close(): Promise<void> {}
}
