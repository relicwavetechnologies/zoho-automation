/**
 * ZohoCrmPaginatedClient — production-grade Zoho CRM API v6 client.
 *
 * Key features:
 *   - Provider pagination: page-based up to 2,000, then page_token up to 100K
 *   - Deduplication across pages (CRM can return duplicates on page boundaries)
 *   - Criteria-based search with proper 204 (No Content) handling
 *   - All 5 CRM modules: Leads, Contacts, Accounts, Deals, Tasks
 *   - CRUD: get, create, update, delete
 *   - Token resolution via ZohoTokenService (same pattern as Books)
 *
 * Used by:
 *   - ZohoCrmOps (pipeline summary, lead report, deal forecast)
 *   - zoho-crm.tool.ts (bounded reads, writes, and terminal-safe pagination)
 */

import type { ZohoTokenService } from './zoho-token.service';
import type { IntegrationGrantAccess } from '../persistence/integration-connection.repository';

// ─── Module types ─────────────────────────────────────────────────────────────

export type ZohoCrmModule = 'Leads' | 'Contacts' | 'Accounts' | 'Deals' | 'Tasks';

const VALID_MODULES = new Set<string>(['Leads', 'Contacts', 'Accounts', 'Deals', 'Tasks']);

// ─── Response shapes ──────────────────────────────────────────────────────────

export interface ZohoCrmListResult {
  readonly items:         Array<Record<string, unknown>>;
  readonly hasMore:       boolean;
  readonly page?:         number;
  readonly nextPageToken?: string;
  readonly totalCount?:   number;
}

export interface ZohoCrmRecordResult {
  readonly id:     string;
  readonly data:   Record<string, unknown>;
}

interface ZohoConnectionAuth {
  readonly userId?: string;
  readonly connectionId?: string;
  readonly minimumAccess?: IntegrationGrantAccess;
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

function recordId(item: Record<string, unknown>): string {
  const id = item['id'];
  if (typeof id === 'string') return id;
  if (typeof id === 'number') return String(id);
  return JSON.stringify(item);
}

function dedupeRecords(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const id = recordId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

function normalizeModule(raw: string): ZohoCrmModule {
  const trimmed = raw.trim();
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
  if (VALID_MODULES.has(capitalized)) return capitalized as ZohoCrmModule;
  const plural = capitalized.endsWith('s') ? capitalized : `${capitalized}s`;
  if (VALID_MODULES.has(plural)) return plural as ZohoCrmModule;
  const aliases: Record<string, ZohoCrmModule> = {
    lead: 'Leads', contact: 'Contacts', account: 'Accounts',
    deal: 'Deals', task: 'Tasks', opportunity: 'Deals',
    company: 'Accounts', organisation: 'Accounts', organization: 'Accounts',
    prospect: 'Leads', customer: 'Contacts',
  };
  return aliases[trimmed.toLowerCase()] ?? (trimmed as ZohoCrmModule);
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class ZohoCrmPaginatedClient {
  private readonly crmBase: string;

  constructor(
    private readonly tokenService: ZohoTokenService,
    apiBaseUrl = 'https://www.zohoapis.com',
  ) {
    this.crmBase = `${apiBaseUrl.replace(/\/$/, '')}/crm/v6`;
  }

  // ─── Private HTTP ───────────────────────────────────────────────────────────

  private async request<T>(
    companyId: string,
    path:      string,
    init:      RequestInit = {},
    auth:      ZohoConnectionAuth = {},
  ): Promise<T | null> {
    const connectionAuth = auth.connectionId && auth.userId
      ? await this.tokenService.getValidConnectionAuth({
        companyId,
        userId: auth.userId,
        connectionId: auth.connectionId,
        minimumAccess: auth.minimumAccess ?? 'read_only',
      })
      : null;
    const token = connectionAuth?.accessToken ?? await this.tokenService.getValidToken(companyId);
    const crmBase = connectionAuth
      ? `${connectionAuth.apiBaseUrl}/crm/v6`
      : this.crmBase;
    const url = `${crmBase}${path}`;

    const res = await fetch(url, {
      ...init,
      headers: {
        'Authorization': `Zoho-oauthtoken ${token}`,
        'Content-Type':  'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (res.status === 204) return null;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Zoho CRM ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }

    return res.json() as Promise<T>;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** Fetch one provider page. The caller persists it before continuing. */
  async listRecords(input: {
    companyId:   string;
    userId?:     string;
    connectionId?: string;
    module:      string;
    sortBy?:     string;
    sortOrder?:  'asc' | 'desc';
    fields?:     string[];
    page?:       number;
    pageToken?:  string;
    perPage?:    number;
  }): Promise<ZohoCrmListResult> {
    const mod     = normalizeModule(input.module);
    const perPage = Math.max(1, Math.min(200, input.perPage ?? 25));
    const page = input.page ?? 1;
    const pg = await this.fetchPage(input.companyId, mod, {
      ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : { page }),
      perPage,
      ...(input.sortBy ? { sortBy: input.sortBy } : {}),
      ...(input.sortOrder ? { sortOrder: input.sortOrder } : {}),
      ...(input.fields ? { fields: input.fields } : {}),
    }, input);
    return {
      items: pg.items,
      hasMore: pg.moreRecords,
      ...(input.pageToken === undefined ? { page } : {}),
      ...(pg.nextPageToken ? { nextPageToken: pg.nextPageToken } : {}),
    };
  }

  /**
   * Exhaust ALL pages for a module — used by CRM ops that need the full dataset.
   * Returns every record across all pages (deduplicated).
   * Page-based up to 2,000 records, then page_token up to Zoho's 100,000-record limit.
   */
  async listAllRecords(input: {
    companyId:   string;
    userId?:     string;
    connectionId?: string;
    module:      string;
    sortBy?:     string;
    sortOrder?:  'asc' | 'desc';
    fields?:     string[];
    maxPages?:   number;
  }): Promise<{ items: Array<Record<string, unknown>>; truncated: boolean }> {
    const mod   = normalizeModule(input.module);
    const maxPg = input.maxPages ?? 500;
    const all:  Array<Record<string, unknown>> = [];
    const seen  = new Set<string>();
    let truncated = false;
    let pageToken: string | undefined;

    for (let page = 1; page <= maxPg; page++) {
      const pg = await this.fetchPage(input.companyId, mod, {
        ...(pageToken ? { pageToken } : { page }),
        perPage: 200,
        ...(input.sortBy ? { sortBy: input.sortBy } : {}),
        ...(input.sortOrder ? { sortOrder: input.sortOrder } : {}),
        ...(input.fields ? { fields: input.fields } : {}),
      }, input);

      for (const item of pg.items) {
        const id = recordId(item);
        if (seen.has(id)) continue;
        seen.add(id);
        all.push(item);
      }

      if (!pg.moreRecords) break;
      pageToken = pg.nextPageToken;
      if (page === maxPg) { truncated = true; break; }
    }

    return { items: all, truncated };
  }

  /**
   * Search records using Zoho CRM criteria syntax.
   * Criteria format: (Field:operator:value) with and/or combinators.
   * Example: "(Last_Name:equals:Burns)and(First_Name:starts_with:C)"
   */
  async searchRecords(input: {
    companyId: string;
    userId?:   string;
    connectionId?: string;
    module:    string;
    criteria:  string;
    perPage?:  number;
    page?:     number;
  }): Promise<ZohoCrmListResult> {
    const mod = normalizeModule(input.module);
    const perPage = Math.max(1, Math.min(200, input.perPage ?? 25));
    const page = input.page ?? 1;

    const params = new URLSearchParams({
      criteria: input.criteria,
      per_page: String(perPage),
      page:     String(page),
    });

    const data = await this.request<Record<string, unknown>>(
      input.companyId,
      `/${mod}/search?${params}`,
      {},
      input,
    );

    if (!data) return { items: [], hasMore: false, page };

    const items = asArrayOfRecords(data['data']);
    const info  = asRecord(data['info']);
    const moreRecords = asBoolean(info?.['more_records']) ?? false;

    return { items, hasMore: moreRecords, page };
  }

  /** Search records with Zoho's native free-text `word` parameter. */
  async searchByText(input: {
    companyId: string;
    userId?:   string;
    connectionId?: string;
    module:    string;
    query:     string;
    perPage?:  number;
    page?:     number;
  }): Promise<ZohoCrmListResult> {
    const mod = normalizeModule(input.module);
    const q   = input.query.trim();
    if (!q) return { items: [], hasMore: false, page: 1 };
    const perPage = Math.max(1, Math.min(200, input.perPage ?? 25));
    const page = input.page ?? 1;
    const params = new URLSearchParams({
      word: q,
      per_page: String(perPage),
      page: String(page),
    });
    const data = await this.request<Record<string, unknown>>(
      input.companyId,
      `/${mod}/search?${params}`,
      {},
      input,
    );
    if (!data) return { items: [], hasMore: false, page };
    const items = asArrayOfRecords(data['data']);
    const info = asRecord(data['info']);
    return {
      items,
      hasMore: asBoolean(info?.['more_records']) ?? false,
      page,
    };
  }

  /**
   * Fetch a single record by ID.
   */
  async getRecord(input: {
    companyId: string;
    userId?:   string;
    connectionId?: string;
    module:    string;
    recordId:  string;
  }): Promise<Record<string, unknown> | null> {
    const mod = normalizeModule(input.module);
    const data = await this.request<Record<string, unknown>>(
      input.companyId,
      `/${mod}/${encodeURIComponent(input.recordId)}`,
      {},
      input,
    );
    if (!data) return null;
    const records = asArrayOfRecords(data['data']);
    return records[0] ?? null;
  }

  /**
   * Create a record in a CRM module.
   */
  async createRecord(input: {
    companyId: string;
    userId?:   string;
    connectionId?: string;
    module:    string;
    fields:    Record<string, unknown>;
  }): Promise<ZohoCrmRecordResult> {
    const mod  = normalizeModule(input.module);
    const data = await this.request<Record<string, unknown>>(
      input.companyId,
      `/${mod}`,
      { method: 'POST', body: JSON.stringify({ data: [input.fields] }) },
      { ...input, minimumAccess: 'read_write' },
    );
    if (!data) throw new Error('Zoho CRM createRecord: empty response');

    const items = asArrayOfRecords(data['data']);
    const first = asRecord(items[0]);
    const details = asRecord(first?.['details']);
    const id = asString(details?.['id']) ?? asString(first?.['id']) ?? '';
    if (!id) throw new Error('Zoho CRM createRecord: no id in response');

    return { id, data: first ?? {} };
  }

  /**
   * Update a record in a CRM module.
   */
  async updateRecord(input: {
    companyId: string;
    userId?:   string;
    connectionId?: string;
    module:    string;
    recordId:  string;
    fields:    Record<string, unknown>;
  }): Promise<void> {
    const mod = normalizeModule(input.module);
    await this.request(
      input.companyId,
      `/${mod}/${encodeURIComponent(input.recordId)}`,
      { method: 'PUT', body: JSON.stringify({ data: [{ ...input.fields, id: input.recordId }] }) },
      { ...input, minimumAccess: 'read_write' },
    );
  }

  /**
   * Delete a record from a CRM module.
   */
  async deleteRecord(input: {
    companyId: string;
    userId?:   string;
    connectionId?: string;
    module:    string;
    recordId:  string;
  }): Promise<void> {
    const mod = normalizeModule(input.module);
    await this.request(
      input.companyId,
      `/${mod}/${encodeURIComponent(input.recordId)}`,
      { method: 'DELETE' },
      { ...input, minimumAccess: 'read_write' },
    );
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private async fetchPage(
    companyId: string,
    module:    ZohoCrmModule,
    opts: {
      page?:      number;
      pageToken?: string;
      perPage:    number;
      sortBy?:    string;
      sortOrder?: 'asc' | 'desc';
      fields?:    string[];
    },
    auth: ZohoConnectionAuth = {},
  ): Promise<{ items: Array<Record<string, unknown>>; moreRecords: boolean; nextPageToken?: string }> {
    const params = new URLSearchParams({
      per_page: String(opts.perPage),
    });

    if (opts.pageToken) {
      params.set('page_token', opts.pageToken);
    } else if (opts.page) {
      params.set('page', String(Math.max(1, opts.page)));
    }

    if (opts.sortBy) params.set('sort_by', opts.sortBy);
    if (opts.sortOrder) params.set('sort_order', opts.sortOrder);

    const fieldList = opts.fields && opts.fields.length > 0
      ? opts.fields
      : MODULE_DEFAULT_FIELDS[module];
    if (fieldList && fieldList.length > 0) params.set('fields', fieldList.join(','));

    const data = await this.request<Record<string, unknown>>(
      companyId,
      `/${module}?${params}`,
      {},
      auth,
    );

    if (!data) return { items: [], moreRecords: false };

    const items = asArrayOfRecords(data['data']);
    const info  = asRecord(data['info']);
    const moreRecords = asBoolean(info?.['more_records']) ?? false;
    const nextPageToken = asString(info?.['next_page_token']);

    return { items, moreRecords, ...(nextPageToken ? { nextPageToken } : {}) };
  }
}

// ─── Module default fields (CRM v6 requires `fields` param) ──────────────────

const MODULE_DEFAULT_FIELDS: Record<string, string[]> = {
  Leads: [
    'id', 'First_Name', 'Last_Name', 'Email', 'Company', 'Phone',
    'Lead_Source', 'Lead_Status', 'Annual_Revenue', 'City', 'State', 'Country',
    'Owner', 'Created_Time', 'Modified_Time',
  ],
  Contacts: [
    'id', 'First_Name', 'Last_Name', 'Full_Name', 'Email', 'Phone',
    'Account_Name', 'Title', 'Department', 'Mailing_City',
    'Owner', 'Created_Time', 'Modified_Time',
  ],
  Accounts: [
    'id', 'Account_Name', 'Website', 'Phone', 'Industry',
    'Annual_Revenue', 'Account_Type', 'Billing_City', 'Billing_Country',
    'Owner', 'Created_Time', 'Modified_Time',
  ],
  Deals: [
    'id', 'Deal_Name', 'Amount', 'Stage', 'Closing_Date',
    'Account_Name', 'Contact_Name', 'Probability', 'Type', 'Lead_Source',
    'Owner', 'Created_Time', 'Modified_Time',
  ],
  Tasks: [
    'id', 'Subject', 'Due_Date', 'Status', 'Priority',
    'Who_Id', 'What_Id', 'Description',
    'Owner', 'Created_Time', 'Modified_Time',
  ],
};
