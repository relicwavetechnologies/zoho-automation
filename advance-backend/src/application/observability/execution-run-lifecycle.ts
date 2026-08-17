import type { Logger } from '../../shared/logger';

interface PersistExecutionRunInput {
  readonly requestId: string;
  readonly companyId: string;
  readonly userId?: string;
  readonly channel: string;
  readonly entrypoint: string;
  readonly threadId?: string;
  readonly chatId?: string;
  readonly messageId?: string;
  readonly agentTarget?: string;
}

export interface ExecutionRunLifecycleStore {
  findOrCreateByRequestId(input: PersistExecutionRunInput): Promise<string>;
  completeIfRunning?(executionId: string, latestSummary?: string): Promise<boolean>;
  failIfRunning?(
    executionId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean>;
  complete?(executionId: string, latestSummary?: string): Promise<void>;
  fail?(executionId: string, errorCode: string, errorMessage: string): Promise<void>;
}

export interface AdmitExecutionRunInput {
  readonly runId: string;
  readonly companyId: string;
  readonly userId: string;
  readonly channel: string;
  readonly entrypoint: string;
  readonly threadId?: string;
  readonly chatId?: string;
  readonly messageId?: string;
  readonly agentTarget?: string;
}

/**
 * Owns the durable lifecycle of one authenticated execution run.
 *
 * Admission is idempotent because the same run is observed independently by
 * the runtime, provider proxy, and trace ingest adapters. Terminal state is a
 * first-writer latch: a late trace batch may enrich a run, but it cannot turn
 * an interrupted or failed run back into a successful one.
 */
export class ExecutionRunLifecycle {
  constructor(
    private readonly store: ExecutionRunLifecycleStore,
    private readonly logger: Logger,
  ) {}

  async admit(input: AdmitExecutionRunInput): Promise<string> {
    return this.store.findOrCreateByRequestId({
      requestId: input.runId,
      companyId: input.companyId,
      userId: input.userId,
      channel: input.channel,
      entrypoint: input.entrypoint,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.agentTarget ? { agentTarget: input.agentTarget } : {}),
    });
  }

  async complete(executionId: string, latestSummary?: string): Promise<boolean> {
    if (this.store.completeIfRunning) {
      return this.store.completeIfRunning(executionId, latestSummary);
    }
    if (!this.store.complete) throw new Error('Execution lifecycle store cannot complete runs');
    await this.store.complete(executionId, latestSummary);
    return true;
  }

  async fail(
    executionId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    if (this.store.failIfRunning) {
      return this.store.failIfRunning(executionId, errorCode, errorMessage);
    }
    if (!this.store.fail) throw new Error('Execution lifecycle store cannot fail runs');
    await this.store.fail(executionId, errorCode, errorMessage);
    return true;
  }

  /** Best-effort terminalization for user-facing runtime failures. */
  failDetached(
    executionId: string,
    errorCode: string,
    errorMessage: string,
  ): void {
    void this.fail(executionId, errorCode, errorMessage).catch(error => {
      this.logger.warn('execution.lifecycle.fail_failed', {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
