import config from '../../../config';

export type RuntimeTraceEvent = {
  event: string;
  level: 'info' | 'warn' | 'error';
  occurredAt: string;
  taskId?: string;
  messageId?: string;
  requestId?: string;
  companyId?: string;
  metadata?: Record<string, unknown>;
};

export type TraceSink = {
  mode: 'noop' | 'langsmith';
  emit: (event: RuntimeTraceEvent) => Promise<void>;
};

type LangsmithTraceSinkOptions = {
  endpoint?: string;
  apiKey?: string;
  project?: string;
  fetchImpl?: typeof fetch;
};

export class LangsmithTraceSink implements TraceSink {
  readonly mode = 'langsmith' as const;

  private readonly endpoint: string;

  private readonly apiKey: string;

  private readonly project: string;

  private readonly fetchImpl: typeof fetch;

  constructor(options: LangsmithTraceSinkOptions = {}) {
    const normalizeProject = (value: string): string => value.replace(/^"(.*)"$/, '$1').trim();
    this.endpoint = (options.endpoint ?? config.LANGSMITH_ENDPOINT).replace(/\/$/, '');
    this.apiKey = options.apiKey ?? config.LANGSMITH_API_KEY;
    this.project = normalizeProject(options.project ?? config.LANGSMITH_PROJECT);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async emit(event: RuntimeTraceEvent): Promise<void> {
    const response = await this.fetchImpl(`${this.endpoint}/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        session_name: this.project,
        name: event.event,
        run_type: 'chain',
        start_time: event.occurredAt,
        end_time: event.occurredAt,
        inputs: {
          requestId: event.requestId,
          taskId: event.taskId,
          messageId: event.messageId,
          companyId: event.companyId,
          level: event.level,
        },
        outputs: {
          metadata: event.metadata ?? {},
        },
        tags: ['zoho-automation-runtime', `level:${event.level}`],
      }),
      signal: AbortSignal.timeout(3_000),
    });

    if (!response.ok) {
      throw new Error(`LangSmith trace sink failed (${response.status})`);
    }
  }
}
