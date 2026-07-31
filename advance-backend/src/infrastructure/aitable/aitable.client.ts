/**
 * Transport for AITable's Fusion API.
 *
 * Divo talks to the REST API directly rather than through AITable's published
 * MCP server. That server is a thin wrapper over these same endpoints, is
 * stdio-only with a single process-wide API key — so it cannot serve more than
 * one connection — and drops `filterByFormula` on the floor while telling the
 * caller it filtered. See plans/aitable-integration.md §2.1.
 *
 * Endpoint shapes are ported from the MIT-licensed `apitable` SDK
 * (github.com/apitable/sdk) and corroborated against `n8n-nodes-vika-aitable`.
 * The SDK itself is not a dependency: it pins axios ^0.19.2, which predates the
 * 0.21.1 SSRF fix.
 */

import type { AitableField } from './aitable-field-codec';

/** Why a Fusion API call did not produce a usable answer. */
export type AitableFailureCode =
  /** The key was rejected. It will never work again without being replaced. */
  | 'invalid_key'
  /** Authenticated, but this key may not touch the thing it asked for. */
  | 'forbidden'
  /** AITable could not be reached, or answered with a server fault. */
  | 'unreachable'
  /** Too many requests. AITable's documented ceiling is 5 QPS per key. */
  | 'rate_limited'
  /** Reached and authenticated, but the request itself was wrong. */
  | 'bad_request';

export class AitableError extends Error {
  constructor(
    readonly code: AitableFailureCode,
    message: string,
    readonly status?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AitableError';
  }
}

export interface AitableSpace {
  readonly id: string;
  readonly name: string;
  readonly isAdmin?: boolean;
}

/** Re-exported so callers need only one import for the transport layer. */
export type AitableFieldRecord = AitableField;

export const AITABLE_DEFAULT_BASE_URL = 'https://aitable.ai';

/** Fusion's own ceiling, from the official SDK's constants. Not in the docs. */
export const AITABLE_LIMITS = Object.freeze({
  /** Requests per second, per API key. */
  qps: 5,
  /** Records returned by one read page. */
  maxPageSize: 1000,
  /** Records accepted by one write. Bulk writes must chunk at this. */
  maxWriteBatch: 10,
  requestTimeoutMs: 60_000,
});

export interface AitableNode {
  readonly node_id?: string;
  readonly id?: string;
  readonly name: string;
  readonly type: string;
  readonly icon?: string;
}

export interface AitableRecord {
  readonly recordId: string;
  readonly fields: Record<string, unknown>;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface AitableRecordPage {
  readonly records: AitableRecord[];
  readonly total: number;
  readonly pageNum: number;
  readonly pageSize: number;
}

export interface AitableView {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

export interface ListRecordsOptions {
  readonly viewId?: string;
  readonly fields?: readonly string[];
  readonly filterByFormula?: string;
  readonly sort?: readonly { readonly field: string; readonly order: 'asc' | 'desc' }[];
  readonly pageNum?: number;
  readonly pageSize?: number;
  readonly recordIds?: readonly string[];
}

/**
 * A record as supplied for a write. `recordId` is required by update and
 * forbidden by create, which each endpoint enforces rather than this type.
 */
export interface AitableRecordWrite {
  readonly recordId?: string;
  readonly fields: Record<string, unknown>;
}

/** Seams for tests. Production passes none of these. */
export interface AitableClientOptions {
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Injectable because the throttle is arithmetic over the clock. Reading
   * Date.now() directly made the spacing test depend on whether a millisecond
   * happened to tick mid-run, which is a flaky test rather than a real signal.
   */
  readonly now?: () => number;
}

export class AitableClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = AITABLE_DEFAULT_BASE_URL,
    options: AitableClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  /** Serialises requests on this client so the 5 QPS ceiling is not breached. */
  private nextSlotAt = 0;

  /**
   * Every workspace this key can reach.
   *
   * Doubles as the liveness check for a key, because the Fusion API has no
   * "who am I" endpoint: this is the cheapest call that proves a key is real
   * and tells us something we can name the connection after.
   */
  async listSpaces(): Promise<AitableSpace[]> {
    const body = await this.request<{ spaces?: AitableSpace[] }>('GET', '/fusion/v1/spaces');
    return body.spaces ?? [];
  }

  /** Datasheets, folders, forms and dashboards inside one workspace. */
  async searchNodes(spaceId: string, input: { type?: string; query?: string } = {}): Promise<AitableNode[]> {
    // v2, not v1: only the v2 route accepts a type/query filter. Every other
    // call in this client is v1, so this is deliberate rather than a typo.
    const query = buildQuery({ type: input.type, query: input.query });
    const body = await this.request<{ nodes?: AitableNode[] }>(
      'GET', `/fusion/v2/spaces/${encodeURIComponent(spaceId)}/nodes${query}`,
    );
    return body.nodes ?? [];
  }

  async getNode(spaceId: string, nodeId: string): Promise<AitableNode> {
    return this.request<AitableNode>(
      'GET', `/fusion/v1/spaces/${encodeURIComponent(spaceId)}/nodes/${encodeURIComponent(nodeId)}`,
    );
  }

  async listFields(datasheetId: string, viewId?: string): Promise<AitableFieldRecord[]> {
    const body = await this.request<{ fields?: AitableFieldRecord[] }>(
      'GET', `/fusion/v1/datasheets/${encodeURIComponent(datasheetId)}/fields${buildQuery({ viewId })}`,
    );
    return body.fields ?? [];
  }

  async listViews(datasheetId: string): Promise<AitableView[]> {
    const body = await this.request<{ views?: AitableView[] }>(
      'GET', `/fusion/v1/datasheets/${encodeURIComponent(datasheetId)}/views`,
    );
    return body.views ?? [];
  }

  /**
   * Field writes hang off the space-scoped path while field reads do not —
   * an asymmetry in Fusion itself, encoded once here so no caller has to
   * remember it.
   */
  async createField(
    spaceId: string,
    datasheetId: string,
    field: { name: string; type: string; property?: Record<string, unknown> },
  ): Promise<{ id: string; name: string }> {
    return this.request<{ id: string; name: string }>(
      'POST',
      `/fusion/v1/spaces/${encodeURIComponent(spaceId)}/datasheets/${encodeURIComponent(datasheetId)}/fields`,
      field,
    );
  }

  async deleteField(spaceId: string, datasheetId: string, fieldId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/fusion/v1/spaces/${encodeURIComponent(spaceId)}/datasheets/${encodeURIComponent(datasheetId)}/fields/${encodeURIComponent(fieldId)}`,
    );
  }

  async listRecords(datasheetId: string, options: ListRecordsOptions = {}): Promise<AitableRecordPage> {
    const pageSize = Math.min(options.pageSize ?? 100, AITABLE_LIMITS.maxPageSize);
    const query = buildQuery({
      viewId: options.viewId,
      // Comma-joined, which is the format Fusion documents for this parameter.
      fields: options.fields?.length ? [...options.fields].join(',') : undefined,
      // Passed through and asserted by a test. AITable's own MCP server
      // declared this parameter and then dropped it before the request, so the
      // model received unfiltered rows it believed were filtered.
      filterByFormula: options.filterByFormula,
      recordIds: options.recordIds?.length ? [...options.recordIds].join(',') : undefined,
      sort: options.sort?.length ? JSON.stringify(options.sort) : undefined,
      pageNum: options.pageNum ?? 1,
      pageSize,
      fieldKey: 'name',
      cellFormat: 'json',
    });
    const body = await this.request<{ records?: AitableRecord[]; total?: number; pageNum?: number; pageSize?: number }>(
      'GET', `/fusion/v1/datasheets/${encodeURIComponent(datasheetId)}/records${query}`,
    );
    return {
      records: body.records ?? [],
      total: body.total ?? body.records?.length ?? 0,
      pageNum: body.pageNum ?? options.pageNum ?? 1,
      pageSize: body.pageSize ?? pageSize,
    };
  }

  async createRecords(datasheetId: string, records: readonly AitableRecordWrite[]): Promise<AitableRecord[]> {
    return this.writeInBatches('POST', datasheetId, records.map(record => ({ fields: record.fields })));
  }

  async updateRecords(datasheetId: string, records: readonly AitableRecordWrite[]): Promise<AitableRecord[]> {
    for (const record of records) {
      if (!record.recordId) throw new AitableError('bad_request', 'Every record being updated needs a recordId.');
    }
    return this.writeInBatches('PATCH', datasheetId, records.map(record => ({
      recordId: record.recordId!,
      fields: record.fields,
    })));
  }

  async deleteRecords(datasheetId: string, recordIds: readonly string[]): Promise<void> {
    if (recordIds.length === 0) return;
    const deleted: string[] = [];
    for (const batch of chunk(recordIds, AITABLE_LIMITS.maxWriteBatch)) {
      try {
        await this.request('DELETE',
          `/fusion/v1/datasheets/${encodeURIComponent(datasheetId)}/records${buildQuery({ recordIds: batch.join(',') })}`,
        );
        deleted.push(...batch);
      } catch (cause) {
        // Deletion is permanent, so a caller told "it failed" while ten rows
        // are already gone has been told something worse than nothing.
        if (deleted.length > 0 && cause instanceof AitableError) {
          throw new AitablePartialWriteError([], cause, deleted);
        }
        throw cause;
      }
    }
  }

  /**
   * Fusion accepts at most 10 records per write — a limit that appears only in
   * the official SDK's constants, not in the API documentation. Larger writes
   * are split here so callers never have to know, but a batch that fails after
   * earlier batches succeeded reports what already landed: the alternative is
   * telling the caller nothing was written when some of it was.
   */
  private async writeInBatches(
    method: 'POST' | 'PATCH',
    datasheetId: string,
    records: readonly Record<string, unknown>[],
  ): Promise<AitableRecord[]> {
    const written: AitableRecord[] = [];
    let batchesApplied = 0;
    for (const batch of chunk(records, AITABLE_LIMITS.maxWriteBatch)) {
      try {
        const body = await this.request<{ records?: AitableRecord[] }>(
          method,
          `/fusion/v1/datasheets/${encodeURIComponent(datasheetId)}/records`,
          { records: batch, fieldKey: 'name' },
        );
        batchesApplied += 1;
        written.push(...(body.records ?? []));
      } catch (cause) {
        // Keyed on batches applied, not rows returned. A batch that succeeds
        // but answers without a `records` array still changed the datasheet,
        // and reporting that as a clean failure invites a retry that
        // duplicates every row in it.
        if (batchesApplied > 0 && cause instanceof AitableError) {
          throw new AitablePartialWriteError(written, cause);
        }
        throw cause;
      }
    }
    return written;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.throttle();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(AITABLE_LIMITS.requestTimeoutMs),
      });
    } catch (cause) {
      // A refused connection, a DNS failure or a timeout. Distinct from a
      // rejected key: the caller must not conclude anything about the key.
      throw new AitableError('unreachable', 'Could not reach AITable.', undefined, cause);
    }

    if (!response.ok) throw await failureFor(response);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new AitableError('unreachable', 'AITable returned a response that was not JSON.', response.status, cause);
    }

    // Fusion answers 200 with `success: false` for some application errors, so
    // the HTTP status alone is not proof the call did what it was asked.
    const envelope = payload as { success?: boolean; message?: string; data?: T };
    if (envelope?.success === false) {
      throw new AitableError('bad_request', envelope.message?.trim() || 'AITable rejected the request.', response.status);
    }
    return (envelope?.data ?? envelope) as T;
  }

  /**
   * Fusion allows 5 requests per second per key, so calls are spaced rather
   * than fired together. Being rate-limited mid-write is worse than being
   * slightly slower: a 429 between batches leaves a partial write behind.
   */
  private async throttle(): Promise<void> {
    const gap = 1000 / AITABLE_LIMITS.qps;
    const now = this.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + gap;
    if (slot > now) await this.sleep(slot - now);
  }
}

/**
 * Some records were written and then a later batch failed.
 *
 * This exists because the caller must be able to say which. Reporting a plain
 * failure would tell someone nothing was written when some of it was, and
 * retrying on that basis duplicates rows.
 */
export class AitablePartialWriteError extends Error {
  constructor(
    readonly written: readonly AitableRecord[],
    readonly cause: AitableError,
    /** Ids already removed, when the interrupted operation was a delete. */
    readonly deleted: readonly string[] = [],
  ) {
    super(AitablePartialWriteError.describe(written.length, deleted.length, cause));
    this.name = 'AitablePartialWriteError';
  }

  private static describe(written: number, deleted: number, cause: AitableError): string {
    // A batch can succeed without echoing its rows back, so "some batches
    // applied" is reported even when the count of rows is unknown.
    const applied = deleted > 0
      ? `deleted ${deleted} record${deleted === 1 ? '' : 's'}`
      : written > 0
        ? `accepted ${written} record${written === 1 ? '' : 's'}`
        : 'already applied part of this change';
    return `AITable ${applied} and then failed: ${cause.message}`;
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/** Query string builder that omits absent values rather than sending blanks. */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function failureFor(response: Response): Promise<AitableError> {
  const detail = await response.text().catch(() => '');
  const message = extractMessage(detail);

  // 401 means the key itself is dead and stays dead. 403 means the key is fine
  // but was pointed at something it may not touch. Treating them alike would
  // condemn a working key because one datasheet was off limits.
  if (response.status === 401) {
    return new AitableError('invalid_key', message ?? 'AITable rejected this API key.', 401);
  }
  if (response.status === 403) {
    return new AitableError('forbidden', message ?? 'This AITable key may not access that resource.', 403);
  }
  if (response.status === 429) {
    return new AitableError('rate_limited', message ?? 'AITable is rate limiting this key.', 429);
  }
  if (response.status >= 500) {
    return new AitableError('unreachable', message ?? 'AITable returned a server error.', response.status);
  }
  return new AitableError('bad_request', message ?? `AITable rejected the request (${response.status}).`, response.status);
}

function extractMessage(raw: string): string | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // Not JSON. Fall through rather than surfacing a raw HTML error page.
  }
  return undefined;
}
