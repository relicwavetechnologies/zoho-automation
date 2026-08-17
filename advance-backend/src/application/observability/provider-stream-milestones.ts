export type ProviderStreamMilestone = 'first_byte' | 'first_reasoning' | 'first_text';

export interface ProviderStreamMilestoneEvent {
  readonly kind: ProviderStreamMilestone;
  readonly atMs: number;
}

const MAX_PENDING_SSE_CHARS = 64 * 1_024;

/**
 * Provider-neutral first-output detector for OpenAI-compatible SSE streams.
 *
 * It retains only an incomplete SSE line, never generated text. DeepSeek chat
 * and OpenAI Responses are separate adapters behind this one interface; callers
 * receive first-only milestones and do not need to understand either format.
 */
export class ProviderStreamMilestones {
  private readonly decoder = new TextDecoder();
  private pending = '';
  private readonly emitted = new Set<ProviderStreamMilestone>();

  constructor(
    private readonly emit: (event: ProviderStreamMilestoneEvent) => void,
    private readonly now: () => number = Date.now,
  ) {}

  observe(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.emitOnce('first_byte');
    this.pending += this.decoder.decode(bytes, { stream: true });
    this.consumeCompleteLines();
    if (this.pending.length > MAX_PENDING_SSE_CHARS) {
      this.pending = this.pending.slice(-MAX_PENDING_SSE_CHARS);
    }
  }

  finish(): void {
    this.pending += this.decoder.decode();
    this.consumeCompleteLines(true);
  }

  private consumeCompleteLines(flush = false): void {
    const lines = this.pending.split(/\r?\n/);
    this.pending = flush ? '' : (lines.pop() ?? '');
    for (const line of lines) this.inspectLine(line);
    if (flush && this.pending) this.inspectLine(this.pending);
  }

  private inspectLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const record = payload as Record<string, unknown>;
    const choices = Array.isArray(record['choices']) ? record['choices'] : [];
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object' || Array.isArray(choice)) continue;
      const delta = (choice as Record<string, unknown>)['delta'];
      if (!delta || typeof delta !== 'object' || Array.isArray(delta)) continue;
      const fields = delta as Record<string, unknown>;
      if (hasText(fields['reasoning_content']) || hasText(fields['reasoning']) || hasText(fields['reasoning_text'])) {
        this.emitOnce('first_reasoning');
      }
      if (hasText(fields['content'])) this.emitOnce('first_text');
    }

    const type = typeof record['type'] === 'string' ? record['type'] : '';
    const delta = record['delta'];
    if (type.includes('reasoning') && type.endsWith('.delta') && hasText(delta)) {
      this.emitOnce('first_reasoning');
    }
    if (type === 'response.output_text.delta' && hasText(delta)) {
      this.emitOnce('first_text');
    }
  }

  private emitOnce(kind: ProviderStreamMilestone): void {
    if (this.emitted.has(kind)) return;
    this.emitted.add(kind);
    this.emit({ kind, atMs: this.now() });
  }
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}
