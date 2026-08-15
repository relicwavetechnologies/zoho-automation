/**
 * Finds the invoice behind a lost create response.
 *
 * Zoho Books does not give us an idempotency key. If an invoice create times
 * out after Zoho received it, retrying can bill the customer twice. This module
 * owns the one safe answer: search the same Zoho connection for the exact draft
 * the member approved, and return `unknown` unless the evidence is complete.
 */

import type { ZohoBooksPaginatedClient } from '../../infrastructure/zoho/zoho-books-paginated.client';
import { mapZohoError } from './zoho-error.utils';
import { unwrapZohoRecord } from './zoho-books-write-result';
import {
  INVOICE_WRITE_CEILING_MS,
  matchStagedInvoice,
  stagedInvoiceSearchWindow,
  type StagedInvoice,
} from './zoho-invoice-staging';

export type ZohoInvoiceRecoveryResult =
  | { readonly state: 'found'; readonly invoice: Record<string, unknown>; readonly invoiceId: string }
  | { readonly state: 'absent' }
  | { readonly state: 'unknown'; readonly why: string };

export function createZohoInvoiceRecovery(input: {
  readonly booksClient: ZohoBooksPaginatedClient;
  readonly companyId: string;
  readonly userId: string;
  readonly now: () => Date;
  readonly signal?: AbortSignal;
  /**
   * Zoho list rows usually omit line_items/sub_total. Fetch a bounded number of
   * detail records, then stop as unknown rather than proving absence from a
   * partial check.
   */
  readonly readBackDetailLimit?: number;
  readonly writeCeilingMs?: number;
}) {
  const readBackDetailLimit = input.readBackDetailLimit ?? 25;
  const writeCeilingMs = input.writeCeilingMs ?? INVOICE_WRITE_CEILING_MS;

  const getInvoice = async (staged: StagedInvoice, invoiceId: string) => {
    const payload = await input.booksClient.getEndpoint({
      companyId: input.companyId,
      userId: input.userId,
      connectionId: staged.connectionId,
      path: `/invoices/${encodeURIComponent(invoiceId)}`,
      ...(staged.organizationId ? { organizationId: staged.organizationId } : {}),
    });
    return unwrapZohoRecord(payload, 'invoices');
  };

  const found = async (
    staged: StagedInvoice,
    candidate: Record<string, unknown>,
  ): Promise<ZohoInvoiceRecoveryResult> => {
    const invoiceId = typeof candidate['invoice_id'] === 'string' ? candidate['invoice_id'] : '';
    if (!invoiceId) return { state: 'unknown', why: 'Zoho returned a matching invoice with no id' };

    if (Array.isArray(candidate['line_items'])) {
      return { state: 'found', invoice: candidate, invoiceId };
    }

    try {
      return { state: 'found', invoice: await getInvoice(staged, invoiceId), invoiceId };
    } catch (error) {
      return { state: 'unknown', why: mapZohoError(error) };
    }
  };

  const findCreatedFrom = async (staged: StagedInvoice): Promise<ZohoInvoiceRecoveryResult> => {
    const window = stagedInvoiceSearchWindow(staged, input.now());
    if (!window) return { state: 'unknown', why: 'the draft names no customer to search by' };

    let listed: { items: readonly Record<string, unknown>[]; hasMore: boolean };
    try {
      const result = await input.booksClient.listRecords({
        companyId: input.companyId,
        userId: input.userId,
        connectionId: staged.connectionId,
        moduleName: 'invoices',
        ...(staged.organizationId ? { organizationId: staged.organizationId } : {}),
        filters: {
          customer_id: window.customerId,
          date_start:  window.dateStart,
          date_end:    window.dateEnd,
        },
        perPage: 200,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      listed = { items: result.items, hasMore: result.hasMore };
    } catch (error) {
      return { state: 'unknown', why: mapZohoError(error) };
    }

    if (listed.hasMore) {
      return { state: 'unknown', why: 'this customer has more invoices in that period than Divo could read in one pass' };
    }

    const dispatchAt = (staged.claimedAt ?? staged.createdAt)?.getTime();
    const candidates = dispatchAt === undefined ? [...listed.items] : listed.items.filter(item => {
      const created = typeof item['created_time'] === 'string' ? Date.parse(item['created_time']) : NaN;
      if (Number.isNaN(created)) return true;
      return created >= dispatchAt - 60_000 && created <= dispatchAt + writeCeilingMs;
    });

    const undecided: Record<string, unknown>[] = [];
    for (const candidate of candidates) {
      const verdict = matchStagedInvoice(staged, candidate);
      if (verdict === 'match') return found(staged, candidate);
      if (verdict === 'undecidable') undecided.push(candidate);
    }

    for (const candidate of undecided.slice(0, readBackDetailLimit)) {
      const id = typeof candidate['invoice_id'] === 'string' ? candidate['invoice_id'] : '';
      if (!id) return { state: 'unknown', why: 'Zoho listed an invoice with no id to fetch' };

      let detail: Record<string, unknown>;
      try {
        detail = await getInvoice(staged, id);
      } catch (error) {
        return { state: 'unknown', why: mapZohoError(error) };
      }

      const verdict = matchStagedInvoice(staged, detail);
      if (verdict === 'match') return found(staged, detail);
      if (verdict === 'undecidable') {
        return { state: 'unknown', why: 'an invoice in Zoho could not be compared against the draft' };
      }
    }

    if (undecided.length > readBackDetailLimit) {
      return {
        state: 'unknown',
        why: `there were more invoices for this customer than Divo could check one by one (${undecided.length})`,
      };
    }

    return { state: 'absent' };
  };

  return { findCreatedFrom };
}
