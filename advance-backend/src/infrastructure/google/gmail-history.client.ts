import { createHash } from 'node:crypto';
import type {
  MailMessageMetadata,
  NewMailEvent,
} from '../../application/mail-ops/mail-ops.types';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** The media-upload host. A different origin, not a path on the one above. */
const GMAIL_UPLOAD_API = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
/**
 * Above this many raw bytes, a draft goes through the upload endpoint.
 *
 * The ordinary endpoint takes the whole message base64-encoded inside a JSON
 * body, which inflates it by a third and is capped around 5 MB — so a forward
 * of a 4 MB attachment failed outright, and the member saw a rule that had
 * worked all week stop for one message with a provider error. Set at 3 MiB so
 * the encoded body stays comfortably under that cap rather than at it.
 */
const GMAIL_JSON_DRAFT_LIMIT_BYTES = 3 * 1024 * 1024;
/**
 * What Gmail itself will carry. Nothing can make a larger message send.
 *
 * Refused here, by name, rather than left to become a provider error five
 * retries later: the mail is too big for Gmail and no amount of trying changes
 * that, so the honest answer is to say so once and stop.
 */
const GMAIL_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const MAX_HISTORY_PAGES = 10;
/**
 * The window a stale-cursor recovery sweeps, and how much of it it will read.
 *
 * Gmail keeps roughly a week of history, so a cursor is only ever rejected
 * after a gap of about that long — and the old sweep looked back one day and
 * took at most a hundred messages. Everything older simply vanished, with no
 * record that it had. Seven days matches what the cursor could have missed.
 *
 * Re-reading mail Divo already handled is harmless: an event's ID is derived
 * from the message, and a delivery is unique per rule and event, so anything
 * already delivered is refused a second time by the database.
 */
const RECOVERY_WINDOW_QUERY = 'in:inbox newer_than:7d';
const MAX_RECOVERY_MESSAGES = 500;
const RECOVERY_PAGE_SIZE = 100;
/**
 * A hard stop on recovery pages, independent of how many messages they yield.
 *
 * A filtered `messages.list` can return a page holding nothing while still
 * handing back a next-page token — the same provider behaviour the history
 * pass already has to survive. Counting only messages meant a run of empty
 * pages advanced nothing and the loop kept asking, holding the mailbox claim
 * for as long as Gmail cared to keep issuing tokens.
 */
const MAX_RECOVERY_PAGES = 20;
/**
 * How many `format=full` message fetches run at once.
 *
 * One history pass can name a thousand messages, and firing a thousand
 * concurrent requests at Gmail exhausts the per-user quota and gets the whole
 * batch throttled — which fails the sync and leaves the cursor where it was, so
 * the next pass does exactly the same thing.
 */
const MESSAGE_FETCH_CONCURRENCY = 6;
const MAX_BODY_CHARS = 50_000;
/**
 * Stamped on everything Mail Ops forwards, and skipped on the way back in.
 *
 * A destination that aliases into the same mailbox plus a rule matching only on
 * subject re-matches its own `Fwd:` output, forever. Nothing else in the
 * pipeline can tell Divo's own forward apart from ordinary mail.
 */
const MAILOPS_HEADER = 'X-Divo-Mailops';

export interface GmailHistorySync {
  nextHistoryId: string;
  events: NewMailEvent[];
  staleCursorRecovered: boolean;
  /**
   * More history was waiting than one pass is willing to read. The cursor
   * returned is a real position part-way through the backlog, so the caller
   * should come straight back rather than wait for the next reconciliation.
   */
  truncated: boolean;
  /**
   * Where to resume the same history walk. Present only on a truncated pass.
   *
   * A page token is bound to the `startHistoryId` it was issued under, so a
   * caller storing this must hand back the *unchanged* cursor with it.
   */
  nextPageToken?: string;
  /** How many messages a stale-cursor recovery swept back in. */
  recoveredMessageCount?: number;
  /**
   * The recovery window held more mail than one pass will read, so some of
   * what the dead cursor missed is gone for good. Reported rather than
   * swallowed: the old code dropped the remainder and called it a clean sync.
   */
  recoveryTruncated?: boolean;
}

export class GmailHistoryClient {
  constructor(
    private readonly request: typeof fetch = fetch,
  ) {}

  async sync(input: {
    accessToken: string;
    historyId?: string;
    /** Resume point from a previous truncated pass, with its cursor. */
    pageToken?: string;
  }): Promise<GmailHistorySync> {
    if (!input.historyId) {
      const profile = await this.getJson<{ historyId?: string }>(
        `${GMAIL_API}/profile`,
        input.accessToken,
      );
      if (!profile.historyId) throw new Error('Gmail profile returned no historyId.');
      return {
        nextHistoryId: profile.historyId,
        events: [],
        staleCursorRecovered: false,
        truncated: false,
      };
    }

    try {
      return await this.syncHistory(
        input.accessToken,
        input.historyId,
        input.pageToken,
      );
    } catch (error) {
      if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
      return this.reconcileStaleCursor(input.accessToken);
    }
  }

  async watch(input: {
    accessToken: string;
    topicName: string;
  }): Promise<{ historyId: string; expiration: Date }> {
    const response = await this.getJson<{
      historyId?: string;
      expiration?: string;
    }>(`${GMAIL_API}/watch`, input.accessToken, {
      method: 'POST',
      body: JSON.stringify({
        topicName: input.topicName,
        labelIds: ['INBOX'],
        labelFilterBehavior: 'include',
      }),
    });
    if (!response.historyId || !response.expiration) {
      throw new Error('Gmail watch returned no historyId or expiration.');
    }
    const expiration = new Date(Number(response.expiration));
    if (Number.isNaN(expiration.getTime())) {
      throw new Error('Gmail watch returned an invalid expiration.');
    }
    return { historyId: response.historyId, expiration };
  }

  /**
   * Stage a forward as a Gmail draft, and hand back its ID.
   *
   * The caller persists that ID before anything is sent, which is the whole
   * point: a draft is an identifier Divo owns and Gmail answers about
   * immediately. What it replaces was a search for the `Message-ID` we had
   * asked Gmail to use — twice unreliable, because `messages.send` commonly
   * substitutes its own and demotes ours to `X-Google-Original-Message-ID`,
   * and because `rfc822msgid:` reads an eventually-consistent index that was
   * being queried seconds after the send it was meant to detect. Send
   * succeeded, the response was lost, the retry forwarded again.
   */
  async createForwardDraft(input: {
    accessToken: string;
    destination: string;
    mailboxEmail: string;
    sourceMessageId: string;
    source: MailMessageMetadata;
    idempotencyKey: string;
    ruleId: string;
  }): Promise<string> {
    const messageId = `<${input.idempotencyKey.replace(/[^a-z0-9.-]/gi, '')}@mailops.divo>`;
    const subject = /^fwd:/i.test(input.source.subject)
      ? input.source.subject
      : `Fwd: ${input.source.subject || '(no subject)'}`;
    const source = await this.getJson<{ raw?: string }>(
      `${GMAIL_API}/messages/${encodeURIComponent(input.sourceMessageId)}?format=raw`,
      input.accessToken,
    );
    if (!source.raw) throw new Error('Gmail source message returned no raw MIME.');
    const raw = buildForwardMime({
      destination: input.destination,
      mailboxEmail: input.mailboxEmail,
      subject,
      messageId,
      source: input.source,
      sourceRaw: Buffer.from(source.raw, 'base64url'),
      idempotencyKey: input.idempotencyKey,
      ruleId: input.ruleId,
    });
    if (raw.length > GMAIL_MAX_MESSAGE_BYTES) {
      throw new MailTooLargeError(raw.length, GMAIL_MAX_MESSAGE_BYTES);
    }
    const draft = raw.length > GMAIL_JSON_DRAFT_LIMIT_BYTES
      ? await this.createDraftFromRaw(raw, input.accessToken)
      : await this.getJson<{ id?: string }>(
        `${GMAIL_API}/drafts`,
        input.accessToken,
        {
          method: 'POST',
          body: JSON.stringify({ message: { raw: raw.toString('base64url') } }),
        },
      );
    if (!draft.id) throw new Error('Gmail draft creation returned no draft ID.');
    return draft.id;
  }

  /**
   * Stages a draft by uploading its MIME bytes directly.
   *
   * One request, not a resumable session: `uploadType=media` carries a whole
   * message up to Gmail's own size cap, and nothing bigger can be sent at all,
   * so there is no range a resumable upload would reach that this does not.
   * The bytes go up as `message/rfc822` rather than base64 inside JSON, which
   * is what removes the ceiling — the encoding was the limit, not the size.
   */
  private async createDraftFromRaw(
    raw: Buffer,
    accessToken: string,
  ): Promise<{ id?: string }> {
    const response = await this.request(
      `${GMAIL_UPLOAD_API}/drafts?uploadType=media`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'message/rfc822',
        },
        // A Buffer is a Uint8Array, which every fetch implementation accepts
        // as a body. Cast because the DOM typings here do not say so.
        body: raw as unknown as NonNullable<RequestInit['body']>,
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new GmailApiError(
        response.status,
        providerError(payload),
        providerReason(payload),
      );
    }
    return payload as { id?: string };
  }

  /** Sends a staged draft. Gmail consumes the draft, so this is not repeatable. */
  async sendForwardDraft(input: {
    accessToken: string;
    draftId: string;
  }): Promise<string> {
    const sent = await this.getJson<{ id?: string }>(
      `${GMAIL_API}/drafts/send`,
      input.accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ id: input.draftId }),
      },
    );
    if (!sent.id) throw new Error('Gmail draft send returned no message ID.');
    return sent.id;
  }

  /**
   * Applies an `organize` rule to the message where it sits.
   *
   * Unlike a forward there is no draft dance here, because Gmail's `modify` is
   * idempotent by construction: adding a label already present and removing one
   * already gone are both no-ops that return the same message. A retry after a
   * lost response therefore cannot do anything twice, which is why this needs
   * none of the staging the send path is built around.
   *
   * Returns the message ID so the delivery row records what it acted on.
   */
  async organizeMessage(input: {
    accessToken: string;
    messageId: string;
    addLabelIds?: readonly string[];
    removeLabelIds?: readonly string[];
  }): Promise<string> {
    const modified = await this.getJson<{ id?: string }>(
      `${GMAIL_API}/messages/${encodeURIComponent(input.messageId)}/modify`,
      input.accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          addLabelIds: [...(input.addLabelIds ?? [])],
          removeLabelIds: [...(input.removeLabelIds ?? [])],
        }),
      },
    );
    if (!modified.id) throw new Error('Gmail modify returned no message ID.');
    return modified.id;
  }

  /**
   * The ID of a user label, created if the member does not have it yet.
   *
   * Names are compared case-insensitively because Gmail treats `Receipts` and
   * `receipts` as the same label and refuses to create the second — so a
   * case-sensitive lookup would find nothing, try to create it, and fail
   * permanently on a label that was there all along. Nesting is by `/`, which is
   * Gmail's own convention and needs nothing special here.
   *
   * System labels are matched too: a rule naming `Starred` should star the mail
   * rather than create a user label that shadows the name.
   */
  async resolveLabelId(input: {
    accessToken: string;
    name: string;
  }): Promise<string> {
    const wanted = input.name.trim().toLowerCase();
    const existing = await this.getJson<{
      labels?: Array<{ id?: string; name?: string }>;
    }>(`${GMAIL_API}/labels`, input.accessToken);
    const found = (existing.labels ?? []).find(
      label => label.name?.trim().toLowerCase() === wanted,
    );
    if (found?.id) return found.id;

    try {
      const created = await this.getJson<{ id?: string }>(
        `${GMAIL_API}/labels`,
        input.accessToken,
        {
          method: 'POST',
          body: JSON.stringify({
            name: input.name.trim(),
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show',
          }),
        },
      );
      if (!created.id) throw new Error('Gmail label creation returned no ID.');
      return created.id;
    } catch (error) {
      // Two deliveries for the same new label race here, and the loser must not
      // fail: the label it wanted now exists, put there by the winner.
      if (error instanceof GmailApiError && error.status === 409) {
        const after = await this.getJson<{
          labels?: Array<{ id?: string; name?: string }>;
        }>(`${GMAIL_API}/labels`, input.accessToken);
        const settled = (after.labels ?? []).find(
          label => label.name?.trim().toLowerCase() === wanted,
        );
        if (settled?.id) return settled.id;
      }
      throw error;
    }
  }

  /**
   * Did a previously staged draft already go out?
   *
   * Gmail deletes a draft when it is sent, so absence is proof of a completed
   * send and presence is proof that no send completed. Neither answer depends
   * on an index catching up.
   */
  async forwardDraftPending(input: {
    accessToken: string;
    draftId: string;
  }): Promise<boolean> {
    try {
      await this.getJson<{ id?: string }>(
        `${GMAIL_API}/drafts/${encodeURIComponent(input.draftId)}?format=minimal`,
        input.accessToken,
      );
      return true;
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) return false;
      throw error;
    }
  }

  /**
   * Drains history from `historyId` forward, up to a bounded number of pages.
   *
   * The bound used to throw. That wedged the mailbox permanently: the throw
   * failed the sync, the cursor stayed exactly where it was, and five minutes
   * later the same oversized range threw again — forever, on the busiest
   * mailboxes, which are the ones the feature exists for.
   *
   * It now stops and reports where it got to. The subtlety is *which* cursor
   * to report. `payload.historyId` is the mailbox's newest history ID, not the
   * end of the page — handing that back after reading ten pages of a fifteen
   * page backlog would silently skip the last five. So a truncated pass
   * returns the ID of the last history record it actually consumed, and the
   * caller comes straight back for the rest. Re-reading that one record is
   * harmless; events and deliveries are both deduplicated.
   */
  private async syncHistory(
    accessToken: string,
    historyId: string,
    resumeToken?: string,
  ): Promise<GmailHistorySync> {
    const messageIds = new Set<string>();
    let nextHistoryId = historyId;
    let truncated = false;
    let pageToken: string | undefined = resumeToken;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const query = new URLSearchParams({
        startHistoryId: historyId,
        historyTypes: 'messageAdded',
        labelId: 'INBOX',
        maxResults: '100',
        ...(pageToken ? { pageToken } : {}),
      });
      const payload = await this.getJson<{
        historyId?: string;
        nextPageToken?: string;
        history?: Array<{
          id?: string;
          messagesAdded?: Array<{ message?: { id?: string } }>;
        }>;
      }>(`${GMAIL_API}/history?${query}`, accessToken);
      nextHistoryId = payload.historyId ?? nextHistoryId;
      for (const history of payload.history ?? []) {
        for (const added of history.messagesAdded ?? []) {
          if (added.message?.id) messageIds.add(added.message.id);
        }
      }
      pageToken = payload.nextPageToken;
      if (!pageToken) break;
      if (page === MAX_HISTORY_PAGES - 1) {
        truncated = true;
        break;
      }
    }
    return {
      // A truncated pass keeps the cursor exactly where it started, because the
      // page token it hands back is only valid against that `startHistoryId`.
      // Progress is carried by the token, not by the cursor; the cursor moves
      // once when the whole walk finishes. This used to guess forward to the
      // last consumed record, which made progress only when a pass consumed
      // something — ten pages of history Divo does not care about advanced
      // nothing, so the next pass read the same ten pages and failed the same
      // way, forever.
      nextHistoryId: truncated ? historyId : nextHistoryId,
      events: await this.loadEvents(accessToken, [...messageIds]),
      staleCursorRecovered: false,
      truncated,
      ...(truncated && pageToken ? { nextPageToken: pageToken } : {}),
    };
  }

  private async reconcileStaleCursor(
    accessToken: string,
  ): Promise<GmailHistorySync> {
    const profile = await this.getJson<{ historyId?: string }>(
      `${GMAIL_API}/profile`,
      accessToken,
    );
    if (!profile.historyId) throw new Error('Gmail profile returned no historyId.');

    const ids: string[] = [];
    let pageToken: string | undefined;
    let recoveryTruncated = false;
    for (let page = 0; page < MAX_RECOVERY_PAGES; page++) {
      const query = new URLSearchParams({
        q: RECOVERY_WINDOW_QUERY,
        maxResults: String(Math.min(
          RECOVERY_PAGE_SIZE,
          MAX_RECOVERY_MESSAGES - ids.length,
        )),
        ...(pageToken ? { pageToken } : {}),
      });
      const payload = await this.getJson<{
        messages?: Array<{ id?: string }>;
        nextPageToken?: string;
      }>(`${GMAIL_API}/messages?${query}`, accessToken);
      for (const message of payload.messages ?? []) {
        if (message.id) ids.push(message.id);
      }
      pageToken = payload.nextPageToken;
      if (!pageToken) break;
      // More was waiting than this pass will read, whether that bound was the
      // message count or the page count. Said out loud, because the
      // alternative — the old behaviour — was to drop the remainder and report
      // a clean sync.
      if (ids.length >= MAX_RECOVERY_MESSAGES || page === MAX_RECOVERY_PAGES - 1) {
        recoveryTruncated = true;
        break;
      }
    }

    return {
      nextHistoryId: profile.historyId,
      events: await this.loadEvents(accessToken, ids),
      staleCursorRecovered: true,
      recoveredMessageCount: ids.length,
      recoveryTruncated,
      truncated: false,
    };
  }

  /**
   * Fetch every named message, a few at a time.
   *
   * A message that has gone missing between the history record and this fetch —
   * deleted, or moved by another client — is skipped rather than allowed to
   * fail the pass. It cannot be delivered by anyone, ever, and failing on it
   * would wedge the cursor: the next pass reads the same history, finds the same
   * dead message and dies the same way, while every later arrival waits behind
   * it.
   *
   * Every other failure still aborts the batch. Those are transient, and
   * skipping them would advance the cursor past mail nobody has read.
   */
  private async loadEvents(
    accessToken: string,
    ids: string[],
  ): Promise<NewMailEvent[]> {
    const events: NewMailEvent[] = [];
    for (let start = 0; start < ids.length; start += MESSAGE_FETCH_CONCURRENCY) {
      const batch = ids.slice(start, start + MESSAGE_FETCH_CONCURRENCY);
      const loaded = await Promise.all(
        batch.map(id => this.loadEvent(accessToken, id)),
      );
      for (const event of loaded) {
        if (event) events.push(event);
      }
    }
    return events;
  }

  private async loadEvent(
    accessToken: string,
    id: string,
  ): Promise<NewMailEvent | null> {
    let message: GmailMessage;
    try {
      message = await this.getJson<GmailMessage>(
        `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`,
        accessToken,
      );
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) return null;
      throw error;
    }
    return {
      providerMessageId: id,
      ...(message.threadId ? { providerThreadId: message.threadId } : {}),
      historyId: message.historyId ?? '0',
      metadata: messageMetadata(message),
      occurredAt: new Date(Number(message.internalDate ?? Date.now())),
    };
  }

  private async getJson<T>(
    url: string,
    accessToken: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.request(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new GmailApiError(
        response.status,
        providerError(payload),
        providerReason(payload),
      );
    }
    return payload as T;
  }
}

/**
 * The forward is larger than Gmail will carry.
 *
 * Its own type because it is the one send failure that retrying cannot fix.
 * Everything else in this client is worth another attempt; this is worth
 * telling the member about and stopping.
 */
export class MailTooLargeError extends Error {
  constructor(readonly bytes: number, readonly limit: number) {
    super(
      `This message is ${Math.round(bytes / 1024 / 1024)} MB, and Gmail will `
        + `not send anything over ${Math.round(limit / 1024 / 1024)} MB.`,
    );
    this.name = 'MailTooLargeError';
  }
}

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * Google's machine-readable reason — `insufficientPermissions`,
     * `rateLimitExceeded`, and so on.
     *
     * Carried because the HTTP status alone cannot separate the two things a
     * `403` means, and the prose message is not a contract: it is
     * human-facing English that Google rewrites whenever it likes. Anything
     * deciding what to tell a member has to key off this, not off the
     * sentence.
     */
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

export interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
  headers?: Array<{ name?: string; value?: string }>;
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  historyId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailMessagePart;
}

// Header names are ASCII protocol tokens, so they fold with `toLowerCase`:
// a locale-sensitive fold would turn `Content-ID` into `content-ıd` under a
// Turkish locale and quietly change what this file recognises.
function messageMetadata(message: GmailMessage): MailMessageMetadata {
  const headers = new Map(
    (message.payload?.headers ?? []).map(header => [
      header.name?.toLowerCase() ?? '',
      header.value ?? '',
    ]),
  );
  // A recipient header can legally appear more than once, and `Delivered-To`
  // does so as a matter of course: an alias or group expansion adds one per
  // hop, and the address the member actually typed is on whichever hop the
  // chain started at. Keeping one of them — which is all a map of headers can
  // hold — means a rule on that alias fires or does not depending on the order
  // Gmail happened to return the trace in.
  const allValuesOf = (name: string): string =>
    (message.payload?.headers ?? [])
      .filter(header => header.name?.toLowerCase() === name)
      // Any newline inside a value goes first, so the separator below is one
      // only this client can create. A folded value would otherwise reset the
      // matcher's parse mid-name and discard the entry: `"Smith,\r\n Ana"
      // <ana@example.com>` is one honest recipient, and losing it is a rule
      // that silently stops firing.
      .map(header => header.value?.replace(/[\r\n]+/g, ' ').trim())
      .filter((value): value is string => Boolean(value))
      // Newline, not comma: the matcher treats it as a hard boundary, so one
      // instance leaving a quote or comment open cannot swallow the next.
      .join('\n');
  const to = allValuesOf('to');
  const cc = allValuesOf('cc');
  const bcc = allValuesOf('bcc');
  const deliveredTo = allValuesOf('delivered-to');
  return {
    // Through the same flattening as the recipient headers: `from` is parsed
    // the same way, so a folded display name would be discarded the same way
    // and the rule would silently stop firing.
    from: sanitizeHeader(headers.get('from') ?? ''),
    // Carried so a recipient rule sees every address the message was actually
    // sent to, not just the one the sender addressed it to.
    to,
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    ...(deliveredTo ? { deliveredTo } : {}),
    subject: headers.get('subject') ?? '',
    ...(headers.get('date') ? { date: headers.get('date')! } : {}),
    snippet: message.snippet ?? '',
    bodyText: extractBody(message.payload).slice(0, MAX_BODY_CHARS),
    hasAttachment: hasAttachment(message.payload),
    // Present only on mail Divo forwarded itself. Carried through so the sync
    // loop can refuse to match its own output.
    ...(headers.get(MAILOPS_HEADER.toLowerCase())
      ? { forwardedByRuleId: headers.get(MAILOPS_HEADER.toLowerCase())! }
      : {}),
  };
}

export function extractBody(part: GmailMessagePart | undefined): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return decodeBody(part.body.data);
  }
  const plain = (part.parts ?? [])
    .map(child => extractBody(child))
    .find(Boolean);
  if (plain) return plain;
  if (part.mimeType === 'text/html' && part.body?.data) {
    return stripHtml(decodeBody(part.body.data));
  }
  return '';
}

export function hasAttachment(part: GmailMessagePart | undefined): boolean {
  if (!part) return false;
  return isAttachedFile(part)
    || (part.parts ?? []).some(child => hasAttachment(child));
}

/**
 * Whether this part is a file someone attached, rather than one the message
 * draws itself with.
 *
 * A signature logo, a tracking pixel and an embedded screenshot all carry a
 * filename, so a filename alone made `hasAttachment` true for most ordinary
 * corporate mail — a rule asking for "invoices with attachments" matched every
 * message with a logo in the footer. What separates the two is that an inline
 * part is referenced by the body: it says so in `Content-Disposition`, or it
 * carries the `Content-ID` the HTML points at.
 */
function isAttachedFile(part: GmailMessagePart): boolean {
  if (!part.filename?.trim()) return false;
  const headers = new Map(
    (part.headers ?? []).map(header => [
      header.name?.toLowerCase() ?? '',
      header.value ?? '',
    ]),
  );
  const disposition = (headers.get('content-disposition') ?? '')
    .trimStart()
    .toLowerCase();
  // A part that says `attachment` outright is one, whatever else it carries:
  // some clients stamp a `Content-ID` on every part they emit, and reading
  // that as inline would stop an attachment rule firing on real attachments.
  if (disposition.startsWith('attachment')) return true;
  return !disposition.startsWith('inline') && !headers.has('content-id');
}

function decodeBody(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function buildForwardMime(input: {
  destination: string;
  mailboxEmail: string;
  subject: string;
  messageId: string;
  source: MailMessageMetadata;
  sourceRaw: Buffer;
  idempotencyKey: string;
  ruleId: string;
}): Buffer {
  const original = splitRawMessage(input.sourceRaw);
  const contentHeaders = selectContentHeaders(original.headers);
  const boundary = `=_divo_${createHash('sha256')
    .update(input.idempotencyKey)
    .digest('hex')
    .slice(0, 32)}`;
  const intro = [
    'Forwarded by Divo Mail Ops',
    '',
    `From: ${sanitizeHeader(input.source.from)}`,
    `To: ${sanitizeHeader(input.source.to)}`,
    ...(input.source.date
      ? [`Date: ${sanitizeHeader(input.source.date)}`]
      : []),
    `Subject: ${sanitizeHeader(input.source.subject)}`,
  ].join('\r\n');
  const prefix = [
    `From: ${sanitizeHeader(input.mailboxEmail)}`,
    `To: ${sanitizeHeader(input.destination)}`,
    `Subject: ${sanitizeHeader(input.subject)}`,
    `Message-ID: ${input.messageId}`,
    `${MAILOPS_HEADER}: ${sanitizeHeader(input.ruleId)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    intro,
    '',
    `--${boundary}`,
    '',
  ].join('\r\n');
  const suffix = `\r\n--${boundary}--\r\n`;
  // Three pieces with three different encodings, which is the whole point.
  //
  // The intro is Divo's own text and is UTF-8. The forwarded body is bytes and
  // is never touched. The original's content headers sit between them and must
  // be written back as the exact bytes they arrived as: they were read with
  // `latin1`, which maps bytes 1:1, so re-encoding them as UTF-8 would turn
  // every byte above 0x7F into two — mangling a `Content-Type` boundary
  // parameter or a filename, and taking the whole part with it.
  return Buffer.concat([
    Buffer.from(prefix, 'utf8'),
    Buffer.from(contentHeaders.join('\r\n'), 'latin1'),
    Buffer.from('\r\n\r\n', 'utf8'),
    original.body,
    Buffer.from(suffix, 'utf8'),
  ]);
}

function splitRawMessage(raw: Buffer): {
  headers: string;
  body: Buffer;
} {
  const crlfBoundary = raw.indexOf(Buffer.from('\r\n\r\n'));
  const lfBoundary = raw.indexOf(Buffer.from('\n\n'));
  const useCrlf = crlfBoundary >= 0
    && (lfBoundary < 0 || crlfBoundary <= lfBoundary);
  const boundary = useCrlf ? crlfBoundary : lfBoundary;
  const separatorLength = useCrlf ? 4 : 2;
  if (boundary < 0) throw new Error('Gmail source message has invalid raw MIME.');
  return {
    headers: raw.subarray(0, boundary).toString('latin1'),
    body: raw.subarray(boundary + separatorLength),
  };
}

function selectContentHeaders(rawHeaders: string): string[] {
  const blocks: string[] = [];
  for (const line of rawHeaders.replace(/\r\n/g, '\n').split('\n')) {
    if (/^[ \t]/.test(line) && blocks.length > 0) {
      blocks[blocks.length - 1] += `\r\n${line}`;
    } else {
      blocks.push(line);
    }
  }
  const allowed = new Set([
    'content-type',
    'content-transfer-encoding',
    'content-language',
  ]);
  const selected = blocks.filter(block => {
    const separator = block.indexOf(':');
    return separator > 0
      && allowed.has(block.slice(0, separator).trim().toLowerCase());
  });
  if (!selected.some(block => /^content-type:/i.test(block))) {
    selected.unshift('Content-Type: text/plain; charset=UTF-8');
  }
  return selected;
}

function providerError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'Gmail API request failed.';
  const error = (payload as Record<string, unknown>)['error'];
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>)['message'];
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return 'Gmail API request failed.';
}

/**
 * The machine-readable reason inside a Google error payload.
 *
 * `error.errors[0].reason` is the granular one (`rateLimitExceeded`,
 * `insufficientPermissions`); `error.status` is the coarse gRPC-style name
 * (`PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`). Either is a stable identifier;
 * the `message` beside them is not.
 *
 * Read most precise first: `details[].ErrorInfo.reason`, then the legacy
 * `errors[0].reason`, then `error.status`. The first two disagree on exactly
 * the case that matters — a lost scope arrives as `forbidden` in the legacy
 * channel and `ACCESS_TOKEN_SCOPE_INSUFFICIENT` in the new one.
 */
function providerReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const error = (payload as Record<string, unknown>)['error'];
  if (!error || typeof error !== 'object') return undefined;
  // `details[].ErrorInfo.reason` first, because it is the most precise thing
  // Google says. On a scope failure the legacy `errors[0].reason` can be the
  // catch-all `forbidden` while this one is
  // `ACCESS_TOKEN_SCOPE_INSUFFICIENT` — and `forbidden` is the reason we
  // deliberately refuse to read as a scope problem, since a Pub/Sub topic
  // Divo owns raises it too. Without this the member who really did lose a
  // grant would never be told to reconnect.
  const details = (error as Record<string, unknown>)['details'];
  if (Array.isArray(details)) {
    for (const entry of details) {
      const reason = (entry as Record<string, unknown> | undefined)?.['reason'];
      if (typeof reason === 'string' && reason.trim()) return reason.trim();
    }
  }
  const errors = (error as Record<string, unknown>)['errors'];
  if (Array.isArray(errors) && errors.length > 0) {
    const reason = (errors[0] as Record<string, unknown> | undefined)?.['reason'];
    if (typeof reason === 'string' && reason.trim()) return reason.trim();
  }
  const status = (error as Record<string, unknown>)['status'];
  return typeof status === 'string' && status.trim() ? status.trim() : undefined;
}
