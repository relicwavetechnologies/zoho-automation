/**
 * ZohoBooksClient — Zoho Books REST API client.
 *
 * Implements ZohoBooksClientPort (defined in zoho-books.tool.ts).
 * Takes a pre-resolved access token and organizationId.
 *
 * API base: https://www.zohoapis.com/books/v3
 */

import type { ZohoBooksClientPort } from '../../application/tools/families/zoho-books.tool';

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

  async sendInvoice(invoiceId: string, email?: string): Promise<{ invoiceId: string }> {
    await this.call<Record<string, unknown>>(`/invoices/${encodeURIComponent(invoiceId)}/email`, {
      method: 'POST',
      body:   JSON.stringify(email ? { to_mail_ids: [email] } : {}),
    });
    return { invoiceId };
  }

  async recordPayment(fields: Record<string, unknown>): Promise<{ paymentId: string }> {
    const data = await this.call<Record<string, unknown>>('/customerpayments', {
      method: 'POST',
      body:   JSON.stringify(fields),
    });
    const payment = asRec(data['payment']);
    const customerPayment = asRec(data['customerpayment']);
    const paymentId = typeof payment['payment_id'] === 'string'
      ? payment['payment_id']
      : typeof customerPayment['payment_id'] === 'string' ? customerPayment['payment_id'] : '';
    if (!paymentId) throw new Error('Zoho Books recordPayment: no payment_id in response');
    return { paymentId };
  }

  async createExpense(fields: Record<string, unknown>): Promise<{ expenseId: string }> {
    const data = await this.call<Record<string, unknown>>('/expenses', {
      method: 'POST',
      body:   JSON.stringify(fields),
    });
    const expense = asRec(data['expense']);
    const expenseId = typeof expense['expense_id'] === 'string' ? expense['expense_id'] : '';
    if (!expenseId) throw new Error('Zoho Books createExpense: no expense_id in response');
    return { expenseId };
  }

  async createBill(fields: Record<string, unknown>): Promise<{ billId: string }> {
    const data = await this.call<Record<string, unknown>>('/bills', {
      method: 'POST',
      body:   JSON.stringify(fields),
    });
    const bill = asRec(data['bill']);
    const billId = typeof bill['bill_id'] === 'string' ? bill['bill_id'] : '';
    if (!billId) throw new Error('Zoho Books createBill: no bill_id in response');
    return { billId };
  }

  async voidInvoice(invoiceId: string): Promise<{ invoiceId: string }> {
    await this.call<Record<string, unknown>>(`/invoices/${encodeURIComponent(invoiceId)}/status/void`, {
      method: 'POST',
    });
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
