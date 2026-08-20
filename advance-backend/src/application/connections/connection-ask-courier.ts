import type { Logger } from '../../shared/logger';

export type ConnectionAskAnswer = 'answered' | 'no_pending_ask' | 'unreachable';

export interface ConnectionAskCourierDeps {
  /** The Pi controller holding the run that is waiting. */
  readonly controllerUrl: string;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Short on purpose: this is a hand-off, and the run does the work afterwards. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Tell a waiting run that the member has finished.
 *
 * This is the whole of the resume path from the backend's side. The run that
 * asked is still going, still holds its conversation and its permissions, and
 * is blocked on one question, so all that has to travel is the answer.
 *
 * `no_pending_ask` is an ordinary outcome, not a fault. It means the run gave
 * up before the member came back, and the caller's page should say something
 * different rather than treat the connection as wasted.
 */
export class ConnectionAskCourier {
  private readonly log: Logger;

  constructor(private readonly deps: ConnectionAskCourierDeps) {
    this.log = deps.logger.child({ service: 'connection-ask-courier' });
  }

  async answer(askId: string, granted: boolean): Promise<ConnectionAskAnswer> {
    const base = this.deps.controllerUrl.replace(/\/+$/, '');
    const url = `${base}/v1/runtime-asks/${encodeURIComponent(askId)}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const response = await (this.deps.fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ granted }),
        signal: controller.signal,
      });
      if (response.status === 404) return 'no_pending_ask';
      if (!response.ok) {
        this.log.warn('connection.ask.answer_rejected', { askId, status: response.status });
        return 'unreachable';
      }
      return 'answered';
    } catch (error) {
      /*
       * Not fatal to the member. The connection itself is already stored, so a
       * controller that cannot be reached costs them a run, not their consent,
       * and the page can tell them to ask again in the thread.
       */
      this.log.error('connection.ask.answer_failed', {
        askId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'unreachable';
    } finally {
      clearTimeout(timer);
    }
  }
}
