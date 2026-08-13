import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createZohoBooksTool } from '../../src/application/tools/families/zoho-books.tool.ts';
import type { StagedPurchaseOrder } from '../../src/application/zoho/zoho-purchase-order-staging.ts';
import { makeCtx } from './tool-test.helpers.ts';

const connectionId = '11111111-1111-4111-8111-111111111111';
const validFields = {
  vendor_id: 'vendor-1',
  date: '2026-08-14',
  expected_delivery_date: '2026-08-20',
  purchaseorder_number: 'PO-QA-001',
  line_items: [{ item_id: 'item-1', name: 'Packaging', quantity: 10, rate: 42 }],
};

function makeStore() {
  const rows = new Map<string, StagedPurchaseOrder>();
  return {
    rows,
    put: async (row: StagedPurchaseOrder) => { rows.set(row.stagingId, row); },
    get: async ({ stagingId }: { stagingId: string }) => rows.get(stagingId) ?? null,
    claim: async ({ stagingId, marker }: { stagingId: string; marker: string }) => {
      const row = rows.get(stagingId)!;
      if (row.createdPurchaseOrderId) return { claimed: false, heldBy: row.createdPurchaseOrderId };
      rows.set(stagingId, { ...row, createdPurchaseOrderId: marker, claimedAt: new Date() });
      return { claimed: true };
    },
    settle: async ({ stagingId, purchaseOrderId }: { stagingId: string; purchaseOrderId: string }) => {
      rows.set(stagingId, { ...rows.get(stagingId)!, createdPurchaseOrderId: purchaseOrderId });
    },
    release: async ({ stagingId }: { stagingId: string }) => {
      const row = rows.get(stagingId)!;
      rows.set(stagingId, { ...row, createdPurchaseOrderId: undefined, claimedAt: undefined });
    },
    markUnresolved: async ({ stagingId, unresolved }: { stagingId: string; unresolved: string }) => {
      rows.set(stagingId, { ...rows.get(stagingId)!, createdPurchaseOrderId: unresolved });
    },
    findUnresolved: async () => [...rows.values()].filter(row => row.createdPurchaseOrderId?.startsWith('unknown:')),
  };
}

function makeHarness(options: { mutateError?: Error; duplicate?: boolean; duplicateReference?: boolean; lookup?: boolean } = {}) {
  const store = makeStore();
  const mutations: any[] = [];
  const providerCalls: any[] = [];
  const client = {
    listOrganizations: async () => {
      providerCalls.push({ method: 'listOrganizations' });
      return [{ organizationId: 'org-1', name: 'Test Org', isDefault: true, gstNo: 'ORG-GST' }];
    },
    listRecords: async (input: any) => {
      providerCalls.push({ method: 'listRecords', input });
      const duplicateByNumber = input.moduleName === 'purchaseorders' && (options.duplicate || options.lookup);
      const duplicateByReference = input.moduleName === 'purchaseorders' && options.duplicateReference && input.query === 'QUOTE-77';
      return {
        organizationId: 'org-1',
        items: duplicateByNumber
          ? [{ purchaseorder_id: 'po-existing', purchaseorder_number: 'PO-QA-001' }]
          : duplicateByReference
            ? [{ purchaseorder_id: 'po-existing', purchaseorder_number: 'PO-77', reference_number: 'QUOTE-77' }]
            : [],
        hasMore: false,
        page: 1,
      };
    },
    getEndpoint: async (input: any) => {
      providerCalls.push({ method: 'getEndpoint', input });
      if (input.path === '/contacts/vendor-1') {
        return { contact: { contact_id: 'vendor-1', contact_name: 'Prism Supplies', gst_no: 'VENDOR-GST' } };
      }
      if (input.path.startsWith('/purchaseorders/')) {
        return { purchaseorder: { purchaseorder_id: 'po-1', purchaseorder_number: 'PO-QA-001', status: 'draft' } };
      }
      return {};
    },
    mutate: async (input: any) => {
      mutations.push(input);
      if (options.mutateError) throw options.mutateError;
      return {
        organizationId: 'org-1',
        payload: {
          purchaseorder: {
            purchaseorder_id: 'po-1', purchaseorder_number: 'PO-QA-001',
            vendor_name: 'Prism Supplies', status: 'draft', total: 420, currency_code: 'INR',
          },
        },
      };
    },
  };
  const tool = createZohoBooksTool({
    booksClient: client as never,
    financeOps: {} as never,
    purchaseOrderStaging: store as never,
    appBaseUrl: 'https://books.zoho.com',
  });
  return { tool, store, mutations, providerCalls };
}

const ctx = makeCtx('zohoBooks', ['read', 'create']);

describe('Zoho Books purchase orders', () => {
  it('stages the exact payload without writing to Zoho', async () => {
    const { tool, store, mutations } = makeHarness();
    const result = await tool.execute({
      connectionId,
      op: 'stage_purchase_order',
      fields: validFields,
    }, ctx);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.success, true);
    assert.equal(mutations.length, 0);
    assert.equal(store.rows.size, 1);
    assert.match(result.ok ? result.value.stagedSummary! : '', /Nothing has been created or sent/);
  });

  it('replays the stored draft once and reports that it remains unsent', async () => {
    const { tool, store, mutations } = makeHarness();
    const staged = await tool.execute({ connectionId, op: 'stage_purchase_order', fields: validFields }, ctx);
    assert.equal(staged.ok, true);
    const stagingId = staged.ok ? staged.value.stagingId! : '';

    const created = await tool.execute({ connectionId, op: 'create_purchase_order', stagingId }, ctx);
    assert.equal(created.ok, true);
    assert.deepEqual(mutations[0].body, validFields);
    assert.equal(mutations[0].params.ignore_auto_number_generation, 'true');
    assert.equal(store.rows.get(stagingId)?.createdPurchaseOrderId, 'po-1');
    assert.match(created.ok ? created.value.message! : '', /nothing has been sent to the vendor/i);

    const replay = await tool.execute({ connectionId, op: 'create_purchase_order', stagingId }, ctx);
    assert.equal(replay.ok, false);
    assert.equal(mutations.length, 1);
  });

  it('blocks an invalid or duplicate draft before creation', async () => {
    const invalid = makeHarness();
    const bad = await invalid.tool.execute({
      connectionId,
      op: 'stage_purchase_order',
      fields: { vendor_id: 'vendor-1', date: '2026-08-14', line_items: [{ name: 'Unknown', quantity: 0, rate: -1 }] },
    }, ctx);
    assert.equal(bad.ok, true);
    assert.equal(bad.ok && bad.value.success, false);

    const duplicate = makeHarness({ duplicate: true });
    const repeated = await duplicate.tool.execute({ connectionId, op: 'stage_purchase_order', fields: validFields }, ctx);
    assert.equal(repeated.ok, true);
    assert.equal(repeated.ok && repeated.value.success, false);
    assert.match(repeated.ok ? repeated.value.message! : '', /already exists/i);
  });

  it('blocks an exact existing vendor reference before creation', async () => {
    const { tool, mutations } = makeHarness({ duplicateReference: true });
    const { purchaseorder_number: _unused, ...unnumberedFields } = validFields;
    const fields = { ...unnumberedFields, reference_number: 'QUOTE-77' };

    const result = await tool.execute({ connectionId, op: 'stage_purchase_order', fields }, ctx);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.success, false);
    assert.match(result.ok ? result.value.message! : '', /reference QUOTE-77 already exists/i);
    assert.equal(mutations.length, 0);
  });

  it('denies company-wide purchase-order reads under personalized scope before calling Zoho', async () => {
    const { tool, providerCalls } = makeHarness();
    const personalized = makeCtx('zohoBooks', ['read'], { requesterEmail: 'member@example.com' });
    (personalized.perm as any).department = { zohoReadScope: 'personalized' };

    const listed = await tool.execute({ connectionId, op: 'list_purchase_orders' }, personalized);
    const fetched = await tool.execute({ connectionId, op: 'get_purchase_order', purchaseOrderId: 'po-1' }, personalized);

    assert.equal(listed.ok, false);
    assert.equal(fetched.ok, false);
    assert.equal(listed.ok ? '' : listed.error.payload.reason, 'permission_denied');
    assert.equal(fetched.ok ? '' : fetched.error.payload.reason, 'permission_denied');
    assert.deepEqual(providerCalls, []);
  });

  it('locks the draft when a dispatched create loses its response', async () => {
    const { tool, store } = makeHarness({ mutateError: new Error('fetch failed') });
    const staged = await tool.execute({ connectionId, op: 'stage_purchase_order', fields: validFields }, ctx);
    const stagingId = staged.ok ? staged.value.stagingId! : '';
    const created = await tool.execute({ connectionId, op: 'create_purchase_order', stagingId }, ctx);

    assert.equal(created.ok, false);
    assert.match(store.rows.get(stagingId)?.createdPurchaseOrderId ?? '', /^unknown:/);
    assert.match(created.ok ? '' : created.error.message, /will not retry/i);
  });

  it('releases the draft when Zoho explicitly rejects the payload', async () => {
    const { tool, store } = makeHarness({ mutateError: new Error('Zoho Books 400 Bad Request: invalid purchase order') });
    const staged = await tool.execute({ connectionId, op: 'stage_purchase_order', fields: validFields }, ctx);
    const stagingId = staged.ok ? staged.value.stagingId! : '';
    const created = await tool.execute({ connectionId, op: 'create_purchase_order', stagingId }, ctx);

    assert.equal(created.ok, false);
    assert.equal(store.rows.get(stagingId)?.createdPurchaseOrderId, undefined);
  });

  it('reads a purchase order by exact human number', async () => {
    const { tool } = makeHarness({ lookup: true });
    const result = await tool.execute({ connectionId, op: 'get_purchase_order', purchaseOrderId: 'PO-QA-001' }, ctx);
    assert.equal(result.ok, true);
    assert.equal(result.ok && (result.value.data as any).purchaseorder_number, 'PO-QA-001');
  });
});
