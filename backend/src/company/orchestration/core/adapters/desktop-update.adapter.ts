import type { OrchestrationStatusRenderable, OrchestrationUpdateAdapter } from '../update-adapter';

type DesktopUpdateCallbacks = {
  onStatus?: (renderable: OrchestrationStatusRenderable) => Promise<void> | void;
  onLiveText?: (text: string) => Promise<void> | void;
};

export class DesktopOrchestrationUpdateAdapter implements OrchestrationUpdateAdapter {
  readonly channel = 'desktop' as const;

  constructor(private readonly callbacks: DesktopUpdateCallbacks = {}) {}

  async initialize(renderable?: OrchestrationStatusRenderable): Promise<void> {
    if (renderable) {
      await this.callbacks.onStatus?.(renderable);
    }
  }

  async update(renderable: OrchestrationStatusRenderable): Promise<void> {
    await this.callbacks.onStatus?.(renderable);
  }

  async updateLiveText(text: string): Promise<void> {
    await this.callbacks.onLiveText?.(text);
  }

  async finalizeLiveText(text: string): Promise<void> {
    await this.callbacks.onLiveText?.(text);
  }

  startHeartbeat(): void {}

  getStatusMessageId(): string | undefined {
    return undefined;
  }

  async close(): Promise<void> {}
}
