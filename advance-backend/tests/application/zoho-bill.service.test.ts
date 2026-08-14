import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createZohoBillService } from '../../src/application/zoho/zoho-bill.service.ts';
import type { StagedBill } from '../../src/application/zoho/zoho-bill-staging.ts';
import type { ZohoBooksPaginatedClient } from '../../src/infrastructure/zoho/zoho-books-paginated.client.ts';

const context = {
  companyId: 'co-1',
  userId: 'user-1',
  connectionId: 'conn-1',
  correlationId: 'corr-1',
  now: new Date('2026-08-14T10:00:00Z'),
};

const validFields = {
  vendor_id: 'vendor-1',
  bill_number: 'B-1',
  date: '2026-08-14',
  due_date: '2026-08-14',
  line_items: [{ account_id: 'acct-1', name: 'Bank Charges', quantity: 1, rate: 17107.75 }],
};

function makeStore() {
  const rows = new Map<string, StagedBill>();
  return {
    rows,
    put: async (row: StagedBill) => { rows.set(row.stagingId, row); },
    get: async ({ stagingId }: { stagingId: string }) => rows.get(stagingId) ?? null,
    claim: async ({ stagingId, marker }: { stagingId: string; marker: string }) => {
      const row = rows.get(stagingId)!;
      if (row.createdBillId) return { claimed: false, heldBy: row.createdBillId };
      rows.set(stagingId, { ...row, createdBillId: marker, claimedAt: new Date() });
      return { claimed: true };
    },
    settle: async ({ stagingId, billId }: { stagingId: string; billId: string }) => {
      rows.set(stagingId, { ...rows.get(stagingId)!, createdBillId: billId });
    },
    release: async ({ stagingId }: { stagingId: string }) => {
      const row = rows.get(stagingId)!;
      rows.set(stagingId, { ...row, createdBillId: undefined, claimedAt: undefined });
    },
    markUnresolved: async ({ stagingId, unresolved }: { stagingId: string; unresolved: string }) => {
      rows.set(stagingId, { ...rows.get(stagingId)!, createdBillId: unresolved });
    },
    findUnresolved: async () => [...rows.values()].filter(row => row.createdBillId?.startsWith('unknown:')),
  };
}

describe('Zoho bill service', () => {
  it('stages then creates a bill in the resolved Books organization', async () => {
    const store = makeStore();
    let mutation: any;
    const booksClient = {
      listOrganizations: async () => [{ organizationId: 'org-1', isDefault: true, name: 'Relicwave' }],
      getEndpoint: async () => ({ contact: { contact_id: 'vendor-1', contact_name: 'HSBC' } }),
      listRecords: async () => ({ organizationId: 'org-1', items: [], hasMore: false, page: 1 }),
      mutate: async (input: any) => {
        mutation = input;
        return {
          organizationId: 'org-1',
          payload: {
            bill: {
              bill_id: 'bill-1',
              bill_number: 'B-1',
              status: 'open',
              total: '17107.75',
              balance: '17107.75',
              currency_code: 'INR',
            },
          },
        };
      },
    } as unknown as ZohoBooksPaginatedClient;

    const service = createZohoBillService({ booksClient, staging: store as never, appBaseUrl: 'https://books.zoho.com' });
    const staged = await service.stage({ ...context, fields: validFields });
    assert.equal(staged.ok, true);
    const stagingId = staged.ok ? staged.value.stagingId : '';
    const result = await service.create({ ...context, stagingId });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(mutation.organizationId, 'org-1');
    assert.deepEqual(mutation.body, validFields);
    assert.equal(result.value.record['bill_id'], 'bill-1');
    assert.equal(result.value.summary.id, 'bill-1');
    assert.match(result.value.summary.message, /Bill B-1 created in Zoho Books/);
    assert.equal(store.rows.get(stagingId)?.createdBillId, 'bill-1');
  });

  it('refuses to stage a bill payable to the Zoho organization itself', async () => {
    const store = makeStore();
    let mutations = 0;
    const booksClient = {
      listOrganizations: async () => [{ organizationId: 'org-1', isDefault: true, name: 'Relicwave', gstNo: '08AAAAA0000A1Z5' }],
      getEndpoint: async () => ({
        contact: {
          contact_id: 'vendor-self',
          contact_name: 'Relicwave Pvt Ltd',
          gst_no: '08AAAAA0000A1Z5',
        },
      }),
      listRecords: async () => ({ organizationId: 'org-1', items: [], hasMore: false, page: 1 }),
      mutate: async () => {
        mutations += 1;
        return { organizationId: 'org-1', payload: {} };
      },
    } as unknown as ZohoBooksPaginatedClient;

    const service = createZohoBillService({ booksClient, staging: store as never, appBaseUrl: 'https://books.zoho.com' });
    const result = await service.stage({ ...context, fields: { ...validFields, vendor_id: 'vendor-self' } });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.success, false);
    assert.equal(mutations, 0);
    assert.match(result.ok ? result.value.message : '', /own vendor/i);
  });

  it('blocks duplicate bill numbers before creation', async () => {
    const store = makeStore();
    const booksClient = {
      listOrganizations: async () => [{ organizationId: 'org-1', isDefault: true, name: 'Relicwave' }],
      getEndpoint: async () => ({ contact: { contact_id: 'vendor-1', contact_name: 'HSBC' } }),
      listRecords: async () => ({
        organizationId: 'org-1',
        items: [{ bill_id: 'bill-existing', bill_number: 'B-1' }],
        hasMore: false,
        page: 1,
      }),
      mutate: async () => {
        throw new Error('should not write');
      },
    } as unknown as ZohoBooksPaginatedClient;

    const service = createZohoBillService({ booksClient, staging: store as never, appBaseUrl: 'https://books.zoho.com' });
    const result = await service.stage({ ...context, fields: validFields });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.success, false);
    assert.match(result.ok ? result.value.message : '', /already exists/i);
  });
});
