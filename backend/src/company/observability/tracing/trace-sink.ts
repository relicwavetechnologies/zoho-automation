import config from '../../../config';
import { logger } from '../../../utils/logger';
import { LangsmithTraceSink, type RuntimeTraceEvent, type TraceSink } from './langsmith-sink';
import { sanitizeTraceMeta } from './trace-redaction';

class NoopTraceSink implements TraceSink {
  readonly mode = 'noop' as const;

  async emit(): Promise<void> {
    return;
  }
}

const hasLangsmithConfig = (): boolean =>
  Boolean(config.LANGSMITH_TRACING && config.LANGSMITH_API_KEY && config.LANGSMITH_PROJECT);

const sanitizeEvent = (event: RuntimeTraceEvent): RuntimeTraceEvent => ({
  ...event,
  metadata: event.metadata
    ? (sanitizeTraceMeta(event.metadata) as Record<string, unknown>)
    : undefined,
});

const buildSink = (): TraceSink => {
  if (!config.LANGSMITH_TRACING) {
    return new NoopTraceSink();
  }

  if (!hasLangsmithConfig()) {
    logger.warn('runtime.trace.disabled', {
      reason: 'missing_langsmith_configuration',
      tracingEnabled: config.LANGSMITH_TRACING,
      hasApiKey: Boolean(config.LANGSMITH_API_KEY),
      hasProject: Boolean(config.LANGSMITH_PROJECT),
    });
    return new NoopTraceSink();
  }

  return new LangsmithTraceSink();
};

let sink: TraceSink = buildSink();

let sinkFailureLogSuppressed = false;

export const emitRuntimeTrace = (event: Omit<RuntimeTraceEvent, 'occurredAt'> & { occurredAt?: string }): void => {
  const payload = sanitizeEvent({
    ...event,
    occurredAt: event.occurredAt ?? new Date().toISOString(),
  });

  void sink.emit(payload).catch((error) => {
    if (sinkFailureLogSuppressed) {
      return;
    }
    sinkFailureLogSuppressed = true;
    logger.warn('runtime.trace.emit_failed', {
      mode: sink.mode,
      event: payload.event,
      error: error instanceof Error ? error.message : 'unknown_trace_sink_error',
    });
  });
};

export const __test__ = {
  sanitizeEvent,
  setSink(nextSink: TraceSink) {
    sink = nextSink;
    sinkFailureLogSuppressed = false;
  },
  resetSink() {
    sink = buildSink();
    sinkFailureLogSuppressed = false;
  },
  getSinkMode() {
    return sink.mode;
  },
};

