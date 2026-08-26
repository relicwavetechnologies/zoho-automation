import { wrapInfra, type InfraError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';

/**
 * The OpenWA gateway, as Divo talks to it.
 *
 * Ported from the follow-up agent's `openwa.js`, with one structural change: the
 * agent served a single WhatsApp session read from config, and Divo holds ten in
 * one gateway. Every call therefore takes the session id as an argument instead
 * of closing over one.
 *
 * The 429 backoff is kept exactly as it was, because it is correct. OpenWA
 * throttles at 10 requests a second and 100 a minute to protect the underlying
 * WhatsApp session, and a burst of history reads trips it. Backing off and
 * retrying is the difference between a slow reconcile and a chat that silently
 * never gets read.
 */

export interface OpenWaSessionSummary {
  readonly id: string;
  readonly status: string;
  readonly phone?: string;
}

export interface OpenWaChatSummary {
  readonly id: string;
  readonly name?: string;
  readonly isGroup?: boolean;
}

export interface OpenWaWebhook {
  readonly id: string;
  readonly url: string;
}

export interface OpenWaPairing {
  /**
   * The QR as a data URL, per the gateway's `QRCodeResponseDto`.
   *
   * Named `qrCode` because that is the field the gateway sends. Rotates roughly
   * every 20 seconds, so it is streamed rather than stored.
   */
  readonly qrCode?: string;
  readonly pairingCode?: string;
  readonly status: string;
}

/**
 * The gateway's answer to "is this number on WhatsApp".
 *
 * Field names taken from a live response, not from the DTO name: it answers
 * `{ number, exists, whatsappId }`, and `whatsappId` is a `@lid` — WhatsApp's
 * opaque per-account identifier — rather than the `…@c.us` chat id a send is
 * addressed to. Nothing here uses it, and it is typed only so the next person
 * does not reach for it expecting a chat id.
 */
export interface OpenWaNumberCheck {
  readonly number?: string;
  readonly exists: boolean;
  /** Null when the number is not registered. Not a chat id — see above. */
  readonly whatsappId?: string | null;
}

export interface OpenWaBulkRequest {
  readonly batchId: string;
  readonly messages: readonly { readonly chatId: string; readonly text: string }[];
  /** Milliseconds between sends. The gateway clamps this to 1000–60000. */
  readonly delayMs: number;
}

export interface OpenWaBulkAccepted {
  readonly batchId: string;
  readonly status: string;
  readonly totalMessages: number;
}

/** One recipient's outcome, per `BatchMessageResultDto`. */
export interface OpenWaBatchResult {
  readonly chatId: string;
  readonly status: string;
  readonly messageId?: string;
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly sentAt?: string;
}

export interface OpenWaBatchStatus {
  readonly batchId: string;
  readonly status: string;
  readonly progress: {
    readonly total: number;
    readonly sent: number;
    readonly failed: number;
    readonly pending: number;
    readonly cancelled: number;
  };
  readonly results: readonly OpenWaBatchResult[];
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

export interface OpenWaBatchCancelled {
  readonly batchId: string;
  readonly status: string;
  /**
   * True when the gateway refused the cancel because the batch was already
   * over. The caller got what it asked for, so this is reported rather than
   * raised — but it is reported, because "stopped it" and "it had already
   * finished" mean different things to whoever pressed the button.
   */
  readonly alreadyFinished?: boolean;
}

export interface OpenWaClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /**
   * Where OpenWA posts webhooks. It must also appear in the gateway's
   * `SSRF_ALLOWED_HOSTS`, or registration is refused outright.
   */
  readonly publicUrl: string;
  readonly webhookSecret?: string;
}

interface CallOptions {
  readonly timeoutMs?: number;
  readonly retries?: number;
}

/**
 * Whether a failed QR read was really "this session is already linked".
 *
 * Matched on the status *and* the message, not the message alone: 400 is also
 * what a malformed request gets, and quietly reporting one of those as a linked
 * handset would be the same silent-success bug in the other direction.
 */
const isAlreadyAuthenticated = (error: InfraError): boolean =>
  /-> 400:/.test(error.message) && /already authenticated/i.test(error.message);

/**
 * Whether a refused cancel was really "this batch had already finished".
 *
 * Same shape as `isAlreadyAuthenticated`, and matched the same way — status
 * *and* message. A 400 from this route is otherwise a malformed request, and
 * reporting one of those as a completed batch would tell somebody their send
 * had stopped when it is still running.
 */
const isAlreadyTerminal = (error: InfraError): boolean =>
  /-> 400:/.test(error.message)
  && /already (completed|cancelled|failed)|terminal status/i.test(error.message);

class OpenWaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'OpenWaHttpError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Events worth subscribing to. Divo reads conversations, and nothing else. */
const WEBHOOK_EVENTS = ['message.received', 'message.sent'] as const;

export class OpenWaClient {
  constructor(private readonly options: OpenWaClientOptions) {}

  // ── Session lifecycle ────────────────────────────────────────────────────

  health(): Promise<Result<unknown, InfraError>> {
    return this.request('GET', '/health', null, {}, 'health');
  }

  listSessions(): Promise<Result<readonly OpenWaSessionSummary[], InfraError>> {
    return this.request('GET', '/sessions', null, {}, 'listSessions');
  }

  session(sessionId: string): Promise<Result<OpenWaSessionSummary, InfraError>> {
    return this.request('GET', `/sessions/${enc(sessionId)}`, null, {}, 'session');
  }

  /**
   * Register a session and bring it up.
   *
   * Two calls, because the gateway separates them: `POST /sessions` records the
   * session, and `POST /sessions/:id/start` is what actually launches it and
   * produces a QR to scan. A gateway running with `AUTO_START_SESSIONS` has
   * already done the second one; one without it would otherwise hand back a
   * session that can never be paired, and nothing would say why.
   *
   * `name` is the only property the gateway accepts, and the id is its to
   * assign — it answers with a UUID unrelated to the name. Sending an `id`
   * alongside is not merely ignored: validation is strict and rejects the whole
   * request with "property id should not exist". The caller's string is
   * therefore a *name*, and `createSession` returns the id to use from here on.
   */
  async createSession(name: string): Promise<Result<OpenWaSessionSummary, InfraError>> {
    const created = await this.request<OpenWaSessionSummary>(
      'POST',
      '/sessions',
      { name },
      {},
      'createSession',
    );
    if (!created.ok) return created;

    const id = created.value.id;
    const started = await this.request<unknown>(
      'POST',
      `/sessions/${enc(id)}/start`,
      null,
      {},
      'startSession',
    );
    if (!started.ok) return started;

    return ok({ ...created.value, id });
  }

  /**
   * The live pairing state for a session being linked.
   *
   * Read every few seconds while a member has the dialog open: the QR rotates,
   * so anything cached is stale before it can be scanned. That is also why this
   * is proxied rather than screenshotted — the agent's README warns against
   * scanning a saved image for exactly this reason.
   */
  async pairing(sessionId: string): Promise<Result<OpenWaPairing, InfraError>> {
    const result = await this.request<OpenWaPairing>(
      'GET', `/sessions/${enc(sessionId)}/qr`, null, {}, 'pairing',
    );
    if (result.ok) return result;

    // The one success the gateway reports as a failure.
    //
    // Once a handset finishes scanning there is no QR to hand out, and this
    // endpoint answers `400 "Session is already authenticated, no QR code
    // needed"`. Treated as an error that reaches the dialog as "the gateway did
    // not answer" — which is the exact opposite of what happened, at the exact
    // moment somebody is watching to find out whether their scan worked.
    //
    // Translated here rather than at the caller because this is the gateway's
    // vocabulary, and this class is where it stops being anybody else's problem.
    if (isAlreadyAuthenticated(result.error)) {
      return ok({ status: 'ready' });
    }
    return result;
  }

  /** The fallback when a QR will not take: WhatsApp shows a code to type instead. */
  pairingCode(
    sessionId: string,
    phoneE164: string,
  ): Promise<Result<OpenWaPairing, InfraError>> {
    return this.request(
      'POST',
      `/sessions/${enc(sessionId)}/pairing-code`,
      // Digits only. The gateway's field is `phoneNumber` and it does not accept
      // the leading `+`; Divo validates and stores E.164, and this adapter is
      // the one place that knows the wire format differs.
      { phoneNumber: phoneE164.replace(/^\+/, '') },
      {},
      'pairingCode',
    );
  }

  logout(sessionId: string): Promise<Result<unknown, InfraError>> {
    return this.request('POST', `/sessions/${enc(sessionId)}/logout`, null, {}, 'logout');
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  /** Active chats, most recent first. Reads live, so the session must be connected. */
  chats(
    sessionId: string,
    limit = 200,
  ): Promise<Result<readonly OpenWaChatSummary[], InfraError>> {
    return this.request(
      'GET',
      `/sessions/${enc(sessionId)}/chats?limit=${limit}`,
      null,
      { timeoutMs: 60_000 },
      'chats',
    );
  }

  /**
   * History straight from WhatsApp, reaching back past anything this gateway
   * has seen. The reconcile sweep depends on it: a webhook stream that stopped
   * leaves a hole no amount of waiting will fill.
   */
  chatHistory(
    sessionId: string,
    chatId: string,
    limit = 50,
  ): Promise<Result<readonly Record<string, unknown>[], InfraError>> {
    return this.request(
      'GET',
      `/sessions/${enc(sessionId)}/messages/${enc(chatId)}/history?limit=${limit}`,
      null,
      { timeoutMs: 90_000 },
      'chatHistory',
    );
  }

  // ── Writing ──────────────────────────────────────────────────────────────
  //
  // The only outbound path, and it is bulk. There is deliberately no single
  // `sendText` here: Divo has exactly one reason to write to WhatsApp — a
  // broadcast a person composed and had approved — and a convenient one-message
  // send sitting beside it is how "the agent never replies" quietly stops being
  // true. A broadcast of one goes through the same batch as a broadcast of
  // eighty, and is paced, recorded and cancellable for the same reasons.

  /**
   * Whether a number is actually on WhatsApp.
   *
   * Worth a round trip per recipient before a cold send, because the send
   * itself cannot answer this: the gateway returns 201 and a real message id
   * for a number nobody has ever registered, and the failure — if it is
   * reported at all — arrives asynchronously, long after the batch has been
   * declared a success.
   *
   * The gateway wants digits, not E.164, so the `+` is stripped here for the
   * same reason `pairingCode` strips it: this class is where Divo's storage
   * format stops being anybody else's problem.
   */
  checkNumber(
    sessionId: string,
    phoneE164: string,
  ): Promise<Result<OpenWaNumberCheck, InfraError>> {
    const digits = phoneE164.replace(/[^\d]/g, '');
    return this.request(
      'GET',
      `/sessions/${enc(sessionId)}/contacts/check/${enc(digits)}`,
      null,
      // One retry rather than three. This runs once per recipient before a
      // send, so a wedged gateway would otherwise stall the whole review behind
      // a hundred separate backoff ladders.
      { retries: 1, timeoutMs: 15_000 },
      'checkNumber',
    );
  }

  /**
   * Hand a whole broadcast to the gateway as one batch.
   *
   * `batchId` is ours to choose and the gateway treats `(session, batchId)` as
   * unique — a repeat is refused by name rather than sent again, which is what
   * makes this call safe to retry after a timeout whose outcome we never saw.
   *
   * Pacing is the gateway's job, not ours: it waits `delayBetweenMessages`
   * between sends and jitters it, which is both kinder to the account than a
   * tight loop and the only way the whole thing stays under the 10 req/s
   * throttle without Divo modelling the throttle itself.
   *
   * Answers 202 and returns immediately. Nothing here waits for delivery, and
   * there is no webhook for batch progress — `batchStatus` is the only way to
   * find out what happened.
   */
  sendBulk(
    sessionId: string,
    input: OpenWaBulkRequest,
  ): Promise<Result<OpenWaBulkAccepted, InfraError>> {
    return this.request(
      'POST',
      `/sessions/${enc(sessionId)}/messages/send-bulk`,
      {
        batchId: input.batchId,
        messages: input.messages.map(message => ({
          chatId: message.chatId,
          type: 'text',
          content: { text: message.text },
        })),
        options: {
          delayBetweenMessages: input.delayMs,
          randomizeDelay: true,
          // A single bad recipient must not abandon the other ninety-nine. The
          // failure is recorded against that recipient and the batch carries on,
          // which is also what makes "re-run only the failures" meaningful.
          stopOnError: false,
        },
      },
      // Longer than the default: the gateway validates and persists the whole
      // batch — up to a hundred messages — before it answers.
      { timeoutMs: 60_000 },
      'sendBulk',
    );
  }

  /** How far along a batch is, and what happened to each recipient so far. */
  batchStatus(
    sessionId: string,
    batchId: string,
  ): Promise<Result<OpenWaBatchStatus, InfraError>> {
    return this.request(
      'GET',
      `/sessions/${enc(sessionId)}/messages/batch/${enc(batchId)}`,
      null,
      { retries: 1 },
      'batchStatus',
    );
  }

  /**
   * Stop a running batch.
   *
   * Stops the *remainder*. Messages already handed to WhatsApp are gone and
   * cannot be recalled, which is why the screen that offers this says so rather
   * than implying an undo.
   *
   * A batch that has already finished answers 400. That is not an error worth
   * surfacing — the caller asked for it to stop and it has stopped — so it is
   * translated into the state it describes, the same way `pairing` translates
   * the gateway's one success-reported-as-failure.
   */
  async cancelBatch(
    sessionId: string,
    batchId: string,
  ): Promise<Result<OpenWaBatchCancelled, InfraError>> {
    const result = await this.request<OpenWaBatchCancelled>(
      'POST',
      `/sessions/${enc(sessionId)}/messages/batch/${enc(batchId)}/cancel`,
      null,
      {},
      'cancelBatch',
    );
    if (result.ok) return result;
    if (isAlreadyTerminal(result.error)) {
      return ok({ batchId, status: 'completed', alreadyFinished: true });
    }
    return result;
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────

  listWebhooks(sessionId: string): Promise<Result<readonly OpenWaWebhook[], InfraError>> {
    return this.request('GET', `/sessions/${enc(sessionId)}/webhooks`, null, {}, 'listWebhooks');
  }

  deleteWebhook(sessionId: string, webhookId: string): Promise<Result<unknown, InfraError>> {
    return this.request(
      'DELETE',
      `/sessions/${enc(sessionId)}/webhooks/${enc(webhookId)}`,
      null,
      {},
      'deleteWebhook',
    );
  }

  /**
   * Point a session's webhook at Divo, idempotently.
   *
   * An existing subscription for our URL is left alone; a stale one for a
   * different URL is replaced rather than added beside, because two live
   * subscriptions mean every message arrives twice and the second copy is only
   * caught by the idempotency table — which works, but wastes a round trip per
   * message forever.
   */
  async ensureWebhook(sessionId: string): Promise<Result<{ created: boolean; url: string }, InfraError>> {
    const url = `${trimSlash(this.options.publicUrl)}/api/whatsapp/webhook`;

    const existing = await this.listWebhooks(sessionId);
    if (!existing.ok) return existing;

    const rows = Array.isArray(existing.value) ? existing.value : [];
    const mine = rows.find(row => row.url === url);
    if (mine) return ok({ created: false, url });

    // A subscription pointing somewhere else is ours gone stale — most likely a
    // PUBLIC_URL that changed between deploys. Remove it before adding.
    for (const stale of rows) {
      const dropped = await this.deleteWebhook(sessionId, stale.id);
      if (!dropped.ok) return dropped;
    }

    const created = await this.request(
      'POST',
      `/sessions/${enc(sessionId)}/webhooks`,
      {
        url,
        events: [...WEBHOOK_EVENTS],
        ...(this.options.webhookSecret ? { secret: this.options.webhookSecret } : {}),
      },
      {},
      'createWebhook',
    );
    if (!created.ok) return created;
    return ok({ created: true, url });
  }

  // ── Transport ────────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    pathname: string,
    body: unknown,
    options: CallOptions,
    op: string,
  ): Promise<Result<T, InfraError>> {
    const retries = options.retries ?? 3;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return ok(await this.requestOnce<T>(method, pathname, body, options));
      } catch (cause) {
        const throttled = cause instanceof OpenWaHttpError && cause.status === 429;
        if (!throttled || attempt >= retries) {
          return err(wrapInfra('http', `openwa.${op}`, cause));
        }
        // Honour Retry-After when the gateway sends one; otherwise back off
        // exponentially, capped so a wedged gateway cannot stall a worker for
        // minutes on a single call.
        const retryAfterMs = Number((cause as OpenWaHttpError).retryAfter) * 1000;
        const wait = Number.isFinite(retryAfterMs) && retryAfterMs > 0
          ? retryAfterMs
          : Math.min(2000 * 2 ** attempt, 30_000);
        await sleep(wait);
      }
    }
  }

  private async requestOnce<T>(
    method: string,
    pathname: string,
    body: unknown,
    { timeoutMs = 30_000 }: CallOptions,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${trimSlash(this.options.baseUrl)}/api${pathname}`, {
        method,
        headers: {
          'X-API-Key': this.options.apiKey,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }

      if (!response.ok) {
        throw new OpenWaHttpError(
          response.status,
          response.headers.get('Retry-After'),
          `OpenWA ${method} ${pathname} -> ${response.status}: ${text.slice(0, 400)}`,
        );
      }

      // The gateway returns bare arrays on some routes and `{ data: [...] }` on
      // others. Unwrapping here keeps that inconsistency out of every caller.
      if (parsed && typeof parsed === 'object' && 'data' in parsed) {
        return (parsed as { data: T }).data;
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

const enc = (value: string): string => encodeURIComponent(value);
const trimSlash = (value: string): string => value.replace(/\/+$/, '');
