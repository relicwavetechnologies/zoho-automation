/**
 * ZohoCrmClient — Zoho CRM REST API v6 client.
 *
 * Implements ZohoCrmClientPort (defined in zoho-crm.tool.ts).
 * Takes a pre-resolved access token and an optional apiBase override.
 *
 * API base: https://www.zohoapis.com/crm/v6
 */

import type { ZohoCrmClientPort } from '../../application/orchestration/tools/families/zoho-crm.tool';

const DEFAULT_CRM_BASE = 'https://www.zohoapis.com/crm/v6';

const asRec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function extractRecordId(r: unknown): string {
  const rec = asRec(r);
  if (typeof rec['id'] === 'string') return rec['id'];
  if (typeof rec['id'] === 'number') return String(rec['id']);
  return '';
}

export class ZohoCrmClient implements ZohoCrmClientPort {
  private readonly crmBase: string;

  constructor(
    private readonly accessToken: string,
    apiBase?: string,
  ) {
    this.crmBase = `${(apiBase ?? DEFAULT_CRM_BASE).replace(/\/$/, '')}/crm/v6`;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.crmBase}${path}`, {
      ...init,
      headers: {
        Authorization: `Zoho-oauthtoken ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Zoho CRM ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  async searchRecords(module: string, query: string, limit = 20): Promise<unknown[]> {
    const params = new URLSearchParams({ criteria: `(Last_Name:contains:${query})`, per_page: String(Math.min(limit, 200)) });
    try {
      const data = await this.call<Record<string, unknown>>(`/${module}/search?${params}`);
      return Array.isArray(data['data']) ? (data['data'] as unknown[]) : [];
    } catch (e) {
      // 204 / empty results throws on some Zoho endpoints
      if (String(e).includes('204')) return [];
      throw e;
    }
  }

  async getRecord(module: string, recordId: string): Promise<unknown> {
    const data = await this.call<Record<string, unknown>>(`/${module}/${recordId}`);
    const records = Array.isArray(data['data']) ? data['data'] : [];
    return records[0] ?? null;
  }

  async createRecord(module: string, fields: Record<string, unknown>): Promise<{ recordId: string }> {
    const data = await this.call<Record<string, unknown>>(`/${module}`, {
      method: 'POST',
      body:   JSON.stringify({ data: [fields] }),
    });
    const items = Array.isArray(data['data']) ? data['data'] : [];
    const first = asRec(items[0]);
    const details = asRec(first['details']);
    const recordId = extractRecordId(details) || extractRecordId(first);
    if (!recordId) throw new Error('Zoho CRM createRecord: no id in response');
    return { recordId };
  }

  async updateRecord(module: string, recordId: string, fields: Record<string, unknown>): Promise<void> {
    await this.call(`/${module}/${recordId}`, {
      method: 'PUT',
      body:   JSON.stringify({ data: [{ ...fields, id: recordId }] }),
    });
  }

  async deleteRecord(module: string, recordId: string): Promise<void> {
    await this.call(`/${module}/${recordId}`, { method: 'DELETE' });
  }
}
