/**
 * OrchestrationTracer — structured run-level event emitter.
 *
 * One instance is created at the start of each engine run and passed
 * (optionally) through the supervisor → specialist → executor call chain.
 *
 * Design principles:
 *   - All methods are fire-and-forget: they log and swallow DB errors
 *     so that observability failures never break the actual execution.
 *   - Sequence numbers are assigned atomically (++this._seq) so events
 *     are always orderable without DB round-trips.
 *   - The tracer is optional everywhere: callers check `if (tracer)` before
 *     calling, so existing code that doesn't receive a tracer compiles fine.
 *
 * Thread safety: Node.js is single-threaded; the ++this._seq pattern is safe.
 */

import type { ExecutionRepository, AppendStepResultInput } from '../../infrastructure/persistence/execution.repository';
import type { Logger } from '../../shared/logger';
import type { EmitEventInput } from './run-event.types';
import type { StepResult } from '../../domain/orchestration/step-result';
import type { ToolOutcome } from '../../domain/tools/tool-call';

export class OrchestrationTracer {
  private _seq = 0;

  constructor(
    readonly executionRunId: string,
    private readonly repo:   ExecutionRepository,
    private readonly logger: Logger,
    private readonly startMs: number,
  ) {}

  // ─── Event emission ───────────────────────────────────────────────────────

  /** Append a structured event to this run's event stream. */
  emit(input: EmitEventInput): void {
    const seq = ++this._seq;
    const safePayload = input.payload
      ? sanitizePayload(input.payload as unknown as Record<string, unknown>)
      : undefined;

    this.repo.appendEvent({
      executionId: this.executionRunId,
      sequence:    seq,
      phase:       input.phase,
      eventType:   input.eventType,
      actorType:   input.actorType,
      title:       input.title,
      ...(input.actorKey  ? { actorKey: input.actorKey }   : {}),
      ...(input.summary   ? { summary:  input.summary }    : {}),
      ...(input.status    ? { status:   input.status }     : {}),
      ...(safePayload     ? { payload:  safePayload }      : {}),
    }).catch(e => {
      this.logger.warn('tracer.event.write_failed', {
        executionId: this.executionRunId,
        eventType:   input.eventType,
        error:       String(e),
      });
    });
  }

  // ─── Step result persistence ──────────────────────────────────────────────

  /**
   * Persist the outcome of one executor step.
   * Called by the Executor for every StepResult it produces.
   */
  persistStepResult(step: StepResult, stepSeq: number): void {
    const input: AppendStepResultInput = {
      executionId: this.executionRunId,
      sequence:    stepSeq,
      toolName:    step.toolOutcomes.map(o => String(o.toolId)).join(',') || step.stepId,
      success:     step.status === 'success',
      status:      step.status,
      ...(step.summary ? { summary: step.summary } : {}),
      rawOutput:   {
        stepId:     step.stepId,
        agentId:    step.agentId,
        durationMs: step.durationMs,
        outcomes:   step.toolOutcomes.map(safeOutcome),
      },
    };

    this.repo.appendStepResult(input).catch(e => {
      this.logger.warn('tracer.step_result.write_failed', {
        executionId: this.executionRunId,
        stepId:      step.stepId,
        error:       String(e),
      });
    });
  }

  // ─── Run lifecycle ────────────────────────────────────────────────────────

  /** Call when the full orchestration run succeeds. */
  complete(summary: string): void {
    this.repo.complete(this.executionRunId, summary).catch(e => {
      this.logger.warn('tracer.run.complete_failed', {
        executionId: this.executionRunId,
        error:       String(e),
      });
    });
  }

  /** Call when the run fails at any stage. */
  fail(errorCode: string, errorMessage: string): void {
    this.repo.fail(this.executionRunId, errorCode, errorMessage).catch(e => {
      this.logger.warn('tracer.run.fail_update_failed', {
        executionId: this.executionRunId,
        error:       String(e),
      });
    });
  }

  /** Elapsed milliseconds since this tracer was created. */
  elapsedMs(): number {
    return Date.now() - this.startMs;
  }
}

// ─── Safety helpers ───────────────────────────────────────────────────────────

/**
 * Strip keys that must never be persisted in event payloads.
 * Mirrors old backend's REDACTED_KEYS list.
 */
const NEVER_PERSIST_KEYS = new Set([
  'rawEvent', 'rawInput', 'reasoning', 'thinking', 'thinkingText',
  'cot', 'chainOfThought', 'systemPrompt', 'fullPrompt', 'inputMessages',
  'modelInput', 'history', 'historyContext', 'memoryContext',
]);

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (NEVER_PERSIST_KEYS.has(k)) continue;
    if (typeof v === 'string' && v.length > 2000) {
      out[k] = v.slice(0, 2000) + '…[truncated]';
    } else if (Array.isArray(v) && v.length > 50) {
      out[k] = v.slice(0, 50);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function safeOutcome(o: ToolOutcome): Record<string, unknown> {
  return {
    toolId:     String(o.toolId),
    action:     o.action,
    status:     o.status,
    durationMs: o.durationMs,
    ...(o.error ? { error: o.error.slice(0, 500) } : {}),
    // data intentionally omitted — can contain sensitive records
  };
}
