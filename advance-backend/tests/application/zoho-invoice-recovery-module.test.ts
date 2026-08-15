import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createZohoInvoiceRecovery } from '../../src/application/zoho/zoho-invoice-recovery.ts';
import type { StagedInvoice } from '../../src/application/zoho/zoho-invoice-staging.ts';
import type { ZohoBooksPaginatedClient } from '../../src/infrastructure/zoho/zoho-books-paginated.client.ts';

function stagedInvoice(overrides: Partial<StagedInvoice> = {}): StagedInvoice {
  return {
    stagingId: 'stage-1',
    companyId: 'co-1',
    userId: 'user-1',
    connectionId: 'conn-1',
    organizationId: 'org-1',
    payload: {
      customer_id: 'cust-1',
      date: '2026-08-14',
      line_items: [{ name: 'Bank fees', quantity: 1, rate: 100 }],
    },
    summary: 'Create invoice for Bank fees',
    findings: [],
    review: { outcome: 'pass', reason: 'ok', issues: [], unsourced: [] },
    attempt: 1,
    createdAt: new Date('2026-08-14T10:00:00.000Z'),
    claimedAt: new Date('2026-08-14T10:00:00.000Z'),
    expiresAt: new Date('2026-08-15T10:00:00.000Z'),
    ...overrides,
  };
}

describe('Zoho invoice create recovery', () => {
  it('fetches full invoice detail when Zoho list rows cannot prove the match', async () => {
    let listedInput: Record<string, unknown> | undefined;
    let detailFetches = 0;
    const booksClient = {
      listRecords: async (input: Record<string, unknown>) => {
        listedInput = input;
        return {
          organizationId: 'org-1',
          page: 1,
          hasMore: false,
          items: [{
            invoice_id: 'inv-1',
            customer_id: 'cust-1',
            total: '118.00',
            created_time: '2026-08-14T10:00:01.000Z',
          }],
        };
      },
      getEndpoint: async (input: Record<string, unknown>) => {
        detailFetches += 1;
        assert.equal(input.connectionId, 'conn-1');
        assert.equal(input.path, '/invoices/inv-1');
        return {
          invoice: {
            invoice_id: 'inv-1',
            customer_id: 'cust-1',
            invoice_number: 'INV-1',
            sub_total: '100.00',
            line_items: [{ name: 'Bank fees', quantity: 1, rate: 100 }],
          },
        };
      },
    } as unknown as ZohoBooksPaginatedClient;

    const recovery = createZohoInvoiceRecovery({
      booksClient,
      companyId: 'co-1',
      userId: 'user-1',
      now: () => new Date('2026-08-14T10:00:05.000Z'),
    });

    const result = await recovery.findCreatedFrom(stagedInvoice());

    assert.equal(result.state, 'found');
    assert.equal(result.state === 'found' ? result.invoiceId : '', 'inv-1');
    assert.equal(detailFetches, 1);
    assert.deepEqual((listedInput?.filters as Record<string, unknown>), {
      customer_id: 'cust-1',
      date_start: '2026-08-13',
      date_end: '2026-08-15',
    });
  });

  it('returns unknown when the bounded list is incomplete', async () => {
    let detailFetches = 0;
    const booksClient = {
      listRecords: async () => ({
        organizationId: 'org-1',
        page: 1,
        hasMore: true,
        items: [],
      }),
      getEndpoint: async () => {
        detailFetches += 1;
        return {};
      },
    } as unknown as ZohoBooksPaginatedClient;

    const recovery = createZohoInvoiceRecovery({
      booksClient,
      companyId: 'co-1',
      userId: 'user-1',
      now: () => new Date('2026-08-14T10:00:05.000Z'),
    });

    const result = await recovery.findCreatedFrom(stagedInvoice());

    assert.equal(result.state, 'unknown');
    assert.match(result.state === 'unknown' ? result.why : '', /more invoices/);
    assert.equal(detailFetches, 0);
  });

  it('ignores invoices outside the dispatch window before declaring absence', async () => {
    let detailFetches = 0;
    const booksClient = {
      listRecords: async () => ({
        organizationId: 'org-1',
        page: 1,
        hasMore: false,
        items: [{
          invoice_id: 'inv-old',
          customer_id: 'cust-1',
          sub_total: '100.00',
          line_items: [{ name: 'Bank fees', quantity: 1, rate: 100 }],
          created_time: '2026-08-14T09:00:00.000Z',
        }],
      }),
      getEndpoint: async () => {
        detailFetches += 1;
        return {};
      },
    } as unknown as ZohoBooksPaginatedClient;

    const recovery = createZohoInvoiceRecovery({
      booksClient,
      companyId: 'co-1',
      userId: 'user-1',
      now: () => new Date('2026-08-14T10:00:05.000Z'),
    });

    const result = await recovery.findCreatedFrom(stagedInvoice());

    assert.equal(result.state, 'absent');
    assert.equal(detailFetches, 0);
  });
});
