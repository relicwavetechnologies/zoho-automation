/**
 * ZohoBooksClient — Zoho Books REST API client.
 *
 * Implements ZohoBooksClientPort (defined in zoho-books.tool.ts).
 * Takes a pre-resolved access token and organizationId.
 *
 * API base: https://www.zohoapis.com/books/v3
 */

import type { ZohoBooksClientPort } from '../../application/orchestration/tools/families/zoho-books.tool';

/** Root API domain — the `/books/v3` path is appended only here. */
const DEFAULT_API_ROOT = 'https://www.zohoapis.com';

const asRec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export class ZohoBooksClient implements ZohoBooksClientPort {
  private readonly booksBase: string;

  constructor(
    private readonly accessToken:    string,
    private readonly organizationId: string,
    /** Override the API root domain (e.g. for EU/AU/IN data centres). Do NOT include `/books/v3`. */
    apiRoot?: string,
  ) {
    this.booksBase = `${(apiRoot ?? DEFAULT_API_ROOT).replace(/\/$/, '')}/books/v3`;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const connector = path.includes('?') ? '&' : '?';
    const url = `${this.booksBase}${path}${connector}organization_id=${this.organizationId}`;

    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Zoho-oauthtoken ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Zoho Books ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  async listInvoices(limit = 25): Promise<unknown[]> {
    const params = new URLSearchParams({ per_page: String(Math.min(limit, 200)), sort_column: 'date', sort_order: 'D' });
    const data = await this.call<Record<string, unknown>>(`/invoices?${params}`);
    return Array.isArray(data['invoices']) ? data['invoices'] : [];
  }

  async getInvoice(invoiceId: string): Promise<unknown> {
    const data = await this.call<Record<string, unknown>>(`/invoices/${invoiceId}`);
    return asRec(data['invoice']) ?? data;
  }

  async createInvoice(fields: Record<string, unknown>): Promise<{ invoiceId: string }> {
    const data = await this.call<Record<string, unknown>>('/invoices', {
      method: 'POST',
      body:   JSON.stringify(fields),
    });
    const invoice = asRec(data['invoice']);
    const invoiceId = typeof invoice['invoice_id'] === 'string' ? invoice['invoice_id'] : '';
    if (!invoiceId) throw new Error('Zoho Books createInvoice: no invoice_id in response');
    return { invoiceId };
  }

  async listContacts(limit = 25): Promise<unknown[]> {
    const params = new URLSearchParams({ per_page: String(Math.min(limit, 200)) });
    const data = await this.call<Record<string, unknown>>(`/contacts?${params}`);
    return Array.isArray(data['contacts']) ? data['contacts'] : [];
  }

  async getContact(contactId: string): Promise<unknown> {
    const data = await this.call<Record<string, unknown>>(`/contacts/${contactId}`);
    return asRec(data['contact']) ?? data;
  }

  async listExpenses(limit = 25): Promise<unknown[]> {
    const params = new URLSearchParams({ per_page: String(Math.min(limit, 200)), sort_column: 'date', sort_order: 'D' });
    const data = await this.call<Record<string, unknown>>(`/expenses?${params}`);
    return Array.isArray(data['expenses']) ? data['expenses'] : [];
  }
}
