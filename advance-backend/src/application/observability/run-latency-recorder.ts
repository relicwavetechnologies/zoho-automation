import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../../shared/logger';

export type LatencySpanCategory =
  | 'runtime'
  | 'provider'
  | 'gateway'
  | 'authorization'
  | 'persistence'
  | 'memory'
  | 'cache'
  | 'tool'
  | 'delivery';

export type LatencySpanAttributes = Record<string, string | number | boolean | null>;

// Diagnostic dimensions only. Keeping this closed prevents a future caller
// from accidentally persisting prompts, answers, query text, connection IDs,
// or credentials under an innocent-looking span attribute.
const SAFE_LATENCY_ATTRIBUTE_KEYS = new Set([
  'action',
  'attempt',
  'cacheReadTokens',
  'cacheWriteTokens',
  'channel',
  'chatType',
  'count',
  'deliveryMode',
  'errorType',
  'httpStatus',
  'inputTokens',
  'messageCount',
  'model',
  'op',
  'outputTokens',
  'provider',
  'reason',
  'requestBytes',
  'responsesApi',
  'toolCount',
  'toolId',
  'toolName',
]);

export interface CompletedRunLatencySpan {
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly category: LatencySpanCategory;
  readonly source: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly durationMs: number;
  readonly status: 'ok' | 'error';
  readonly attributes?: LatencySpanAttributes;
}

export interface RunLatencySpanStore {
  findOwnedIdByRequestId(input: {
    requestId: string;
    companyId: string;
    userId: string;
  }): Promise<string | null>;
  insertSpans(input: readonly {
    executionId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    category: string;
    source: string;
    startedAt: Date;
    endedAt: Date;
    durationMs: number;
    status: string;
    attributes?: LatencySpanAttributes;
  }[]): Promise<void>;
}

export interface RunLatencyTraceInput {
  readonly runId: string;
  readonly companyId: string;
  readonly userId: string;
  readonly source: string;
  readonly executionId?: string;
  readonly parentSpanId?: string;
}

interface StartSpanInput {
  readonly name: string;
  readonly category: LatencySpanCategory;
  readonly attributes?: LatencySpanAttributes;
  readonly parentSpanId?: string;
  readonly spanId?: string;
}

export interface RunLatencySpanHandle {
  readonly spanId: string;
  end(status?: 'ok' | 'error', attributes?: LatencySpanAttributes): void;
}

/**
 * One request-local causal trace.
 *
 * Callers name meaningful work; this module owns clocks, nesting, bounded safe
 * attributes, idempotent span identity, and best-effort persistence. Its
 * AsyncLocalStorage is instance-local, so concurrent requests cannot become
 * accidental parents of each other.
 */
export class RunLatencyTrace {
  private readonly parent = new AsyncLocalStorage<string>();
  private readonly spans: CompletedRunLatencySpan[] = [];
  private executionId: string | undefined;
  private flushed = false;

  constructor(
    private readonly input: RunLatencyTraceInput,
    private readonly store: RunLatencySpanStore,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly makeId: () => string = randomUUID,
  ) {
    this.executionId = input.executionId;
  }

  bindExecutionId(executionId: string): void {
    this.executionId = executionId;
  }

  startSpan(input: StartSpanInput): RunLatencySpanHandle {
    const startedAtMs = this.now();
    const spanId = (input.spanId ?? `${this.input.source}:${this.makeId()}`).slice(0, 300);
    const parentSpanId = (
      input.parentSpanId
      ?? this.parent.getStore()
      ?? this.input.parentSpanId
    )?.slice(0, 300);
    let ended = false;
    return {
      spanId,
      end: (status = 'ok', attributes) => {
        if (ended) return;
        ended = true;
        const endedAtMs = Math.max(startedAtMs, this.now());
        this.spans.push({
          spanId,
          ...(parentSpanId ? { parentSpanId } : {}),
          name: input.name,
          category: input.category,
          source: this.input.source,
          startedAtMs,
          endedAtMs,
          durationMs: endedAtMs - startedAtMs,
          status,
          ...mergeAttributes(input.attributes, attributes),
        });
      },
    };
  }

  async measure<T>(input: StartSpanInput, work: () => Promise<T>): Promise<T> {
    const span = this.startSpan(input);
    try {
      const result = await this.parent.run(span.spanId, work);
      span.end('ok');
      return result;
    } catch (error) {
      span.end('error', { errorType: safeErrorType(error) });
      throw error;
    }
  }

  addCompleted(span: CompletedRunLatencySpan): void {
    this.spans.push({
      ...span,
      attributes: sanitizeLatencyAttributes(span.attributes),
    });
  }

  /** Record a first-only point in time without claiming wall-clock ownership. */
  milestone(input: StartSpanInput): void {
    const atMs = this.now();
    const spanId = (input.spanId ?? `${this.input.source}:${this.makeId()}`).slice(0, 300);
    const parentSpanId = (
      input.parentSpanId
      ?? this.parent.getStore()
      ?? this.input.parentSpanId
    )?.slice(0, 300);
    this.addCompleted({
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name: input.name,
      category: input.category,
      source: this.input.source,
      startedAtMs: atMs,
      endedAtMs: atMs,
      durationMs: 0,
      status: 'ok',
      ...(input.attributes ? { attributes: input.attributes } : {}),
    });
  }

  snapshot(): readonly CompletedRunLatencySpan[] {
    return [...this.spans];
  }

  /** Best-effort and safe to call without awaiting on a user-facing path. */
  async flush(): Promise<void> {
    if (this.flushed || this.spans.length === 0) return;
    this.flushed = true;
    try {
      const executionId = this.executionId ?? await this.store.findOwnedIdByRequestId({
        requestId: this.input.runId,
        companyId: this.input.companyId,
        userId: this.input.userId,
      });
      if (!executionId) {
        this.logger.debug('latency.trace.run_not_found', {
          runId: this.input.runId,
          source: this.input.source,
        });
        return;
      }
      // One bulk write keeps observability from creating a DB round trip per
      // measured module. Completed spans are immutable; duplicate IDs are
      // retry copies and the repository safely ignores them.
      await this.store.insertSpans(this.spans.map(span => ({
        executionId,
        spanId: span.spanId,
        ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
        name: span.name,
        category: span.category,
        source: span.source,
        startedAt: new Date(span.startedAtMs),
        endedAt: new Date(span.endedAtMs),
        durationMs: span.durationMs,
        status: span.status,
        ...(span.attributes ? { attributes: span.attributes } : {}),
      })));
    } catch (error) {
      this.logger.warn('latency.trace.flush_failed', {
        runId: this.input.runId,
        source: this.input.source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export class RunLatencyRecorder {
  constructor(
    private readonly store: RunLatencySpanStore,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly makeId: () => string = randomUUID,
  ) {}

  trace(input: RunLatencyTraceInput): RunLatencyTrace {
    return new RunLatencyTrace(input, this.store, this.logger, this.now, this.makeId);
  }
}

/** Stable tool parent shared with the Pi trace extension. */
export function piToolSpanId(actionId: string): string {
  return `pi.tool.${actionId}`.slice(0, 300);
}

export async function measureRunLatency<T>(
  trace: RunLatencyTrace | undefined,
  input: StartSpanInput,
  work: () => Promise<T>,
): Promise<T> {
  return trace ? trace.measure(input, work) : work();
}

function mergeAttributes(
  first: LatencySpanAttributes | undefined,
  second: LatencySpanAttributes | undefined,
): { attributes?: LatencySpanAttributes } {
  const merged = sanitizeLatencyAttributes({ ...(first ?? {}), ...(second ?? {}) });
  return Object.keys(merged).length > 0 ? { attributes: merged } : {};
}

export function sanitizeLatencyAttributes(
  input: LatencySpanAttributes | undefined,
): LatencySpanAttributes {
  if (!input) return {};
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key, value]) => (
        SAFE_LATENCY_ATTRIBUTE_KEYS.has(key)
        && (typeof value !== 'number' || Number.isFinite(value))
      ))
      .slice(0, 20)
      .map(([key, value]) => [key.slice(0, 80), typeof value === 'string' ? value.slice(0, 200) : value]),
  );
}

function safeErrorType(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 100) : 'UnknownError';
}
