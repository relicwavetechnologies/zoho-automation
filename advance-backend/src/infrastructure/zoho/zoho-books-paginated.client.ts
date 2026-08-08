/**
 * ZohoBooksPaginatedClient — production-grade Zoho Books API client.
 *
 * Key improvements over the simple ZohoBooksClient:
 *   - Proper pagination: loops pages until `has_more_page = false` (up to 20 pages × 200 = 4 000 records)
 *   - Deduplication across pages (Zoho can return the same record on adjacent pages)
 *   - Full multi-org support via listOrganizations()
 *   - Contact name + company name exact-match search (mirrors old backend behaviour)
 *   - All 11 Zoho Books modules supported
 *   - getRecord() for single-record fetch
 *
 * Used by:
 *   - ZohoFinanceOps (overdue report, etc.)
 *   - ZohoBooksSearchAdapter (context search broker)
 *
 * Ported from:
 *   backend/src/company/integrations/zoho/zoho-books.client.ts
 */

import type { ZohoTokenService } from './zoho-token.service';
import { WriteNotDispatchedError } from '../../shared/errors';
import type { IntegrationGrantAccess } from '../persistence/integration-connection.repository';

// ─── Module types ─────────────────────────────────────────────────────────────

export type ZohoBooksModule =
  | 'contacts'
  | 'invoices'
  | 'estimates'
  | 'creditnotes'
  | 'bills'
  | 'salesorders'
  | 'purchaseorders'
  | 'customerpayments'
  | 'vendorpayments'
  | 'bankaccounts'
  | 'banktransactions'
  | 'expenses'
  | 'items';

// ─── Response shapes ──────────────────────────────────────────────────────────

export interface ZohoBooksOrganization {
  readonly organizationId: string;
  readonly name?:          string;
  readonly isDefault?:     boolean;
  /**
   * The selling state, as Zoho writes it — "RJ", "KA".
   *
   * Which GST a sale attracts depends on where the seller is, and that belongs
   * to the organisation rather than to the deployment: one connection can reach
   * several organisations in several states. Carried here in the same spelling
   * `place_of_supply` uses on an invoice, so the two compare without a mapping
   * table nobody would maintain.
   */
  readonly stateCode?:     string;
}

export interface ZohoBooksListResult {
  readonly organizationId: string;
  readonly items:          Array<Record<string, unknown>>;
  readonly hasMore:        boolean;
  readonly page:           number;
}

interface ZohoConnectionAuth {
  readonly userId?: string;
  readonly connectionId?: string;
  readonly minimumAccess?: IntegrationGrantAccess;
  readonly signal?: AbortSignal;
  /** Already-settled credentials, so a write does not re-resolve them mid-flight. */
  readonly resolved?: { readonly accessToken: string; readonly apiBaseUrl: string };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

const asBoolean = (v: unknown): boolean | undefined =>
  typeof v === 'boolean' ? v : undefined;

const asArrayOfRecords = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : [];

const isRecordValue = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const toPrimitive = (v: unknown): string | undefined => {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
};


/** Read `page_context.has_more_page` from any Zoho Books list response. */
function hasMorePage(raw: Record<string, unknown>): boolean {
  const ctx = asRecord(raw['page_context']);
  return asBoolean(ctx?.['has_more_page']) ?? false;
}

/** Extract the canonical record ID regardless of which module it is. */
function recordId(item: Record<string, unknown>): string {
  return (
    asString(item['invoice_id'])        ??
    asString(item['contact_id'])        ??
    asString(item['estimate_id'])       ??
    asString(item['creditnote_id'])     ??
    asString(item['bill_id'])           ??
    asString(item['salesorder_id'])     ??
    asString(item['purchaseorder_id'])  ??
    asString(item['payment_id'])        ??
    asString(item['transaction_id'])    ??
    asString(item['expense_id'])        ??
    asString(item['item_id'])           ??
    asString(item['account_id'])        ??
    asString(item['id'])                ??
    JSON.stringify(item)
  );
}

function dedupeRecords(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out:  Array<Record<string, unknown>> = [];
  for (const item of items) {
    const id = recordId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class ZohoBooksPaginatedClient {
  private readonly booksBase: string;

  constructor(
    private readonly tokenService: ZohoTokenService,
    apiBaseUrl = 'https://www.zohoapis.com',
  ) {
    this.booksBase = `${apiBaseUrl.replace(/\/$/, '')}/books/v3`;
  }

  // ─── Private HTTP ───────────────────────────────────────────────────────────

  private async request<T>(
    companyId: string,
    path:      string,
    init:      RequestInit = {},
    auth:      ZohoConnectionAuth = {},
  ): Promise<T> {
    const connectionAuth = auth.resolved
      ?? (auth.connectionId && auth.userId
        ? await this.tokenService.getValidConnectionAuth({
          companyId,
          userId: auth.userId,
          connectionId: auth.connectionId,
          minimumAccess: auth.minimumAccess ?? 'read_only',
        })
        : null);
    const token = connectionAuth?.accessToken ?? await this.tokenService.getValidToken(companyId);
    const booksBase = connectionAuth
      ? `${connectionAuth.apiBaseUrl}/books/v3`
      : this.booksBase;
    const sep   = path.includes('?') ? '&' : '?';
    const url   = `${booksBase}${path}${sep}`;

    // A multipart upload must carry the boundary fetch generates for it, so the
    // JSON default has to stay off rather than be overridden with a value that
    // no longer describes the body.
    const isMultipart = init.body instanceof FormData;

    const res = await fetch(url, {
      ...init,
      ...(auth.signal ? { signal: auth.signal } : {}),
      headers: {
        'Authorization': `Zoho-oauthtoken ${token}`,
        ...(isMultipart ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Zoho Books ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }

    return res.json() as Promise<T>;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Fetch all Zoho Books organizations accessible for this company's OAuth token.
   * Returns at least one item if the connection is valid.
   */
  async listOrganizations(companyId: string, auth: ZohoConnectionAuth = {}): Promise<ZohoBooksOrganization[]> {
    try {
      const data = await this.request<Record<string, unknown>>(
        companyId,
        '/organizations',
        {},
        auth,
      );
      return asArrayOfRecords(data['organizations']).map(org => {
        const name      = asString(org['name']);
        const isDefault = asBoolean(org['is_default_org']) ?? asBoolean(org['is_default']);
        const address   = org['address'];
        const stateCode = (isRecordValue(address) ? asString(address['state_code']) : undefined)
          ?? asString(org['state_code']);
        return {
          organizationId: asString(org['organization_id']) ?? asString(org['organizationId']) ?? '',
          ...(name      !== undefined ? { name }      : {}),
          ...(isDefault !== undefined ? { isDefault } : {}),
          ...(stateCode !== undefined ? { stateCode } : {}),
        };
      }).filter(o => o.organizationId.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Resolve organization ID — uses provided one or fetches the default from API.
   */
  async resolveOrganizationId(companyId: string, preferred?: string, auth: ZohoConnectionAuth = {}): Promise<string> {
    if (preferred) return preferred;
    const orgs = await this.listOrganizations(companyId, auth);
    return orgs.find(org => org.isDefault === true)?.organizationId ?? orgs[0]?.organizationId ?? companyId;
  }

  /**
   * Generic GET for Zoho Books endpoints that are not represented by module
   * list APIs, such as /chartofaccounts, /search, and /reports/taxsummary.
   */
  async getEndpoint(input: {
    companyId:       string;
    userId?:         string;
    connectionId?:   string;
    path:            string;
    organizationId?: string;
    params?:         Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const orgId = await this.resolveOrganizationId(input.companyId, input.organizationId, input);
    const path = input.path.startsWith('/') ? input.path : `/${input.path}`;
    const params = new URLSearchParams({ organization_id: orgId });

    for (const [key, value] of Object.entries(input.params ?? {})) {
      const primitive = toPrimitive(value);
      if (primitive !== undefined && primitive.length > 0) {
        params.set(key, primitive);
      }
    }

    return this.request<Record<string, unknown>>(
      input.companyId,
      `${path}?${params}`,
      {},
      input,
    );
  }

  /**
   * Write to any Zoho Books endpoint — the single path every mutation takes.
   *
   * `connectionId` and `userId` are required, and deliberately so. `request()`
   * falls back to the company-level token whenever either is missing, and that
   * fallback never sees `minimumAccess` — so an optional connection here would
   * let a write skip the per-connection read_write check entirely. A write
   * without a connection has to fail, not quietly borrow the company's token.
   */
  async mutate(input: {
    companyId:       string;
    userId:          string;
    connectionId:    string;
    method:          'POST' | 'PUT';
    path:            string;
    organizationId?: string;
    params?:         Record<string, string>;
    body?:           Record<string, unknown>;
    /** Multipart upload. Mutually exclusive with `body`. */
    multipart?: {
      field:    string;
      fileName: string;
      mimeType: string;
      content:  Buffer;
    };
    signal?: AbortSignal;
  }): Promise<{ organizationId: string; payload: Record<string, unknown> }> {
    if (!input.connectionId || !input.userId) {
      throw new WriteNotDispatchedError('Zoho Books writes require an exact connection and the acting member.');
    }

    const auth: ZohoConnectionAuth = {
      userId:        input.userId,
      connectionId:  input.connectionId,
      minimumAccess: 'read_write',
      ...(input.signal ? { signal: input.signal } : {}),
    };

    // Auth and organisation are settled here, before anything is sent, and the
    // resolved token is handed to request() rather than looked up again — so a
    // failure in either is known to have written nothing, and a token cannot
    // expire in the gap between deciding to write and writing.
    let resolved: { accessToken: string; apiBaseUrl: string };
    let orgId: string;
    try {
      resolved = await this.tokenService.getValidConnectionAuth({
        companyId:     input.companyId,
        userId:        input.userId,
        connectionId:  input.connectionId,
        minimumAccess: 'read_write',
      });
      if (input.organizationId) {
        orgId = input.organizationId;
      } else {
        // Not resolveOrganizationId(): that one answers a failed lookup with the
        // companyId, which is fine for a read that will simply find nothing and
        // wrong for a write, which would be dispatched at an organisation that
        // does not exist.
        const organizations = await this.listOrganizations(input.companyId, { ...auth, resolved });
        const chosen = organizations.find(org => org.isDefault === true) ?? organizations[0];
        if (!chosen) {
          throw new Error('Zoho Books returned no organisation for this connection, so there is nowhere to write.');
        }
        orgId = chosen.organizationId;
      }
    } catch (error) {
      throw new WriteNotDispatchedError(
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
    const path  = input.path.startsWith('/') ? input.path : `/${input.path}`;
    const params = new URLSearchParams({ organization_id: orgId });
    for (const [key, value] of Object.entries(input.params ?? {})) {
      if (value.length > 0) params.set(key, value);
    }

    let body: FormData | string | undefined;
    if (input.multipart) {
      const form = new FormData();
      form.append(
        input.multipart.field,
        new Blob([new Uint8Array(input.multipart.content)], { type: input.multipart.mimeType }),
        input.multipart.fileName,
      );
      body = form;
    } else if (input.body) {
      body = JSON.stringify(input.body);
    }

    const payload = await this.request<Record<string, unknown>>(
      input.companyId,
      `${path}?${params}`,
      { method: input.method, ...(body === undefined ? {} : { body }) },
      { ...auth, resolved },
    );

    // The caller needs the org that was actually written to — it is what makes
    // a record link correct when the member named no organisation.
    return { organizationId: orgId, payload };
  }

  /**
   * List records from any Zoho Books module with full automatic pagination.
   *
   * Behaviour:
   *   - When `page` is specified: fetches that exact page only (caller controls pagination)
   *   - When `page` is omitted: loops pages 1..maxPages until `has_more_page = false`,
   *     collecting up to `perPage` deduplicated records
   *
   * Special contact handling: when module='contacts' and a query is given without
   * explicit name filters, tries exact contact_name then company_name lookups first
   * (mirrors old backend behaviour for accurate name matching).
   */
  async listRecords(input: {
    companyId:      string;
    userId?:        string;
    connectionId?:  string;
    moduleName:     ZohoBooksModule;
    organizationId?: string;
    filters?:       Record<string, unknown>;
    query?:         string;
    page?:          number;         // if set, fetch only this page
    perPage?:       number;         // 1-200, default 25
    maxPages?:      number;         // override 20-page cap
    signal?:        AbortSignal;
  }): Promise<ZohoBooksListResult> {
    const orgId   = await this.resolveOrganizationId(input.companyId, input.organizationId, input);
    const perPage = Math.max(1, Math.min(200, input.perPage ?? 25));
    const maxPg   = input.maxPages ?? 20;
    const query   = input.query?.trim();

    // Special: exact-name search for contacts
    if (input.moduleName === 'contacts' && query) {
      const hasNameFilter = Boolean(
        asString(input.filters?.['contact_name']) || asString(input.filters?.['company_name']),
      );
      if (!hasNameFilter) {
        for (const nameField of ['contact_name', 'company_name'] as const) {
          const pg = await this.fetchPage(
            input.companyId,
            input.moduleName,
            orgId,
            { ...(input.filters ?? {}), [nameField]: query },
            undefined,
            1,
            perPage,
            input,
          );
          if (pg.items.length > 0) return { organizationId: orgId, items: pg.items, hasMore: pg.hasMore, page: 1 };
        }
      }
    }

    // Single-page mode
    if (input.page !== undefined) {
      const pg = await this.fetchPage(
        input.companyId, input.moduleName, orgId,
        input.filters, query, input.page, perPage,
        input,
      );
      return { organizationId: orgId, items: pg.items, hasMore: pg.hasMore, page: input.page };
    }

    // Multi-page exhaust mode
    const collected: Array<Record<string, unknown>> = [];
    let lastHasMore = false;

    for (let page = 1; page <= maxPg; page++) {
      const pg = await this.fetchPage(
        input.companyId, input.moduleName, orgId,
        input.filters, query, page, perPage,
        input,
      );
      collected.push(...pg.items);
      const deduped = dedupeRecords(collected);
      lastHasMore   = pg.hasMore;

      if (deduped.length >= perPage || !pg.hasMore) {
        return {
          organizationId: orgId,
          items:          deduped.slice(0, perPage),
          hasMore:        pg.hasMore,
          page,
        };
      }
    }

    return {
      organizationId: orgId,
      items:          dedupeRecords(collected).slice(0, perPage),
      hasMore:        lastHasMore,
      page:           maxPg,
    };
  }

  /**
   * Exhaust ALL pages for a module — used by finance ops that need the full dataset.
   * Returns every record across all pages (deduplicated), up to maxPages × 200.
   */
  async listAllRecords(input: {
    companyId:       string;
    userId?:         string;
    connectionId?:   string;
    moduleName:      ZohoBooksModule;
    organizationId?: string;
    filters?:        Record<string, unknown>;
    query?:          string;
    maxPages?:       number;   // default 20
  }): Promise<{ organizationId: string; items: Array<Record<string, unknown>>; truncated: boolean }> {
    // Zoho only accepts a single status value — split comma-separated values and merge results.
    const rawStatus = asString(input.filters?.['status']);
    if (rawStatus && rawStatus.includes(',')) {
      const statuses = rawStatus.split(',').map(s => s.trim()).filter(Boolean);
      const results  = await Promise.all(
        statuses.map(status => this.listAllRecords({
          ...input,
          filters: { ...(input.filters ?? {}), status },
        })),
      );
      const seen = new Set<string>();
      const all: Array<Record<string, unknown>> = [];
      let truncated = false;
      let orgId = '';
      for (const r of results) {
        if (!orgId) orgId = r.organizationId;
        if (r.truncated) truncated = true;
        for (const item of r.items) {
          const id = recordId(item);
          if (seen.has(id)) continue;
          seen.add(id);
          all.push(item);
        }
      }
      return { organizationId: orgId, items: all, truncated };
    }

    const orgId   = await this.resolveOrganizationId(input.companyId, input.organizationId, input);
    const maxPg   = input.maxPages ?? 20;
    const query   = input.query?.trim();
    const all:    Array<Record<string, unknown>> = [];
    const seen    = new Set<string>();
    let truncated = false;

    for (let page = 1; page <= maxPg; page++) {
      const pg = await this.fetchPage(
        input.companyId, input.moduleName, orgId,
        input.filters, query, page, 200,
        input,
      );

      for (const item of pg.items) {
        const id = recordId(item);
        if (seen.has(id)) continue;
        seen.add(id);
        all.push(item);
      }

      if (!pg.hasMore) break;
      if (page === maxPg) { truncated = true; break; }
    }

    return { organizationId: orgId, items: all, truncated };
  }

  /**
   * Fetch a single record by ID from any module.
   */
  async getRecord(input: {
    companyId:      string;
    userId?:        string;
    connectionId?:  string;
    moduleName:     ZohoBooksModule;
    recordId:       string;
    organizationId?: string;
  }): Promise<Record<string, unknown> | null> {
    const orgId = await this.resolveOrganizationId(input.companyId, input.organizationId, input);
    try {
      const data = await this.request<Record<string, unknown>>(
        input.companyId,
        `/${input.moduleName}/${encodeURIComponent(input.recordId)}?organization_id=${orgId}`,
        {},
        input,
      );
      // Zoho wraps in the singular module name, e.g. { invoice: {...} }
      const singular = input.moduleName.replace(/s$/, '');
      const inner    = asRecord(data[singular]) ?? asRecord(data[input.moduleName]);
      return inner ?? null;
    } catch {
      return null;
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private async fetchPage(
    companyId:      string,
    moduleName:     ZohoBooksModule,
    organizationId: string,
    filters:        Record<string, unknown> | undefined,
    query:          string | undefined,
    page:           number,
    perPage:        number,
    auth:           ZohoConnectionAuth = {},
  ): Promise<{ items: Array<Record<string, unknown>>; hasMore: boolean; raw: Record<string, unknown> }> {
    const params = new URLSearchParams({
      organization_id: organizationId,
      page:            String(Math.max(1, page)),
      per_page:        String(perPage),
    });

    if (query) params.set('search_text', query);

    for (const [k, v] of Object.entries(filters ?? {})) {
      const s = toPrimitive(v);
      if (s !== undefined) params.set(k, s);
    }

    const raw = await this.request<Record<string, unknown>>(
      companyId,
      `/${moduleName}?${params}`,
      {},
      auth,
    );

    // Zoho wraps records in the plural module key, e.g. { invoices: [...] }
    const items = asArrayOfRecords(raw[moduleName]);

    return { items, hasMore: hasMorePage(raw), raw };
  }
}
