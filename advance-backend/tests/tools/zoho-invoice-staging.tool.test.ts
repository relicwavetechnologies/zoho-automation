/**
 * The invariants that stop a draft becoming two invoices, or a different one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './tool-test.helpers.ts';
import { createZohoBooksTool } from '../../src/application/tools/families/zoho-books.tool.ts';
import type { ZohoFinanceOps } from '../../src/application/zoho/zoho-finance-ops.ts';
import type { ZohoBooksPaginatedClient } from '../../src/infrastructure/zoho/zoho-books-paginated.client.ts';
import type { StagedInvoice } from '../../src/application/zoho/zoho-invoice-staging.ts';
import { WriteNotDispatchedError } from '../../src/shared/errors.ts';

const ctx = makeCtx('zohoBooks', ['read', 'create', 'update', 'delete']);

const soundPayload = {
  customer_id: '1500001',
  date: '2026-08-01',
  due_date: '2026-08-31',
  currency_code: 'INR',
  line_items: [{ name: 'Retainer', quantity: 1, rate: 50000 }],
};

function makeStore(seed?: Partial<StagedInvoice>) {
  const rows = new Map<string, StagedInvoice>();
  const calls: string[] = [];
  if (seed?.stagingId) rows.set(seed.stagingId, seed as StagedInvoice);
  return {
    calls,
    rows,
    put: async (staged: StagedInvoice) => { rows.set(staged.stagingId, staged); },
    get: async ({ stagingId }: { stagingId: string }) => rows.get(stagingId) ?? null,
    claim: async ({ stagingId, marker }: { stagingId: string; marker: string }) => {
      calls.push('claim');
      const row = rows.get(stagingId);
      if (!row) return { claimed: false };
      if (row.createdInvoiceId) return { claimed: false, heldBy: row.createdInvoiceId };
      rows.set(stagingId, { ...row, createdInvoiceId: marker });
      return { claimed: true };
    },
    settle: async ({ stagingId, invoiceId }: { stagingId: string; invoiceId: string }) => {
      calls.push('settle');
      const row = rows.get(stagingId);
      if (row) rows.set(stagingId, { ...row, createdInvoiceId: invoiceId });
    },
    release: async ({ stagingId }: { stagingId: string }) => {
      calls.push('release');
      const row = rows.get(stagingId);
      if (row) rows.set(stagingId, { ...row, createdInvoiceId: undefined });
    },
    markUnresolved: async ({ stagingId, unresolved }: { stagingId: string; unresolved: string }) => {
      calls.push('markUnresolved');
      const row = rows.get(stagingId);
      if (row) rows.set(stagingId, { ...row, createdInvoiceId: unresolved });
    },
  };
}

function makeBooksClient(onMutate?: () => void) {
  return {
    mutate: async (input: any) => {
      onMutate?.();
      return {
        organizationId: 'org-1',
        payload: {
          invoice: {
            invoice_id: 'inv-created',
            invoice_number: 'INV-9',
            status: 'draft',
            currency_code: 'INR',
            sub_total: '50000.00',
            total: '59000.00',
            line_items: input.body?.line_items ?? [],
            customer_id: input.body?.customer_id,
          },
        },
      };
    },
    listRecords: async () => ({ organizationId: 'org-1', items: [], hasMore: false, page: 1 }),
    getEndpoint: async () => ({}),
  } as unknown as ZohoBooksPaginatedClient;
}

const passingReview = {
  outcome: 'pass' as const, reason: 'Everything traces to a source.', issues: [], unsourced: [],
};

function makeTool(overrides: {
  store?: ReturnType<typeof makeStore>;
  booksClient?: ZohoBooksPaginatedClient;
  review?: any;
  attachmentSource?: any;
} = {}) {
  return createZohoBooksTool({
    booksClient: overrides.booksClient ?? makeBooksClient(),
    financeOps: {} as ZohoFinanceOps,
    invoiceStaging: (overrides.store ?? makeStore()) as never,
    invoiceReviewer: { review: async () => overrides.review ?? passingReview },
    ...(overrides.attachmentSource ? { attachmentSource: overrides.attachmentSource } : {}),
    appBaseUrl: 'https://books.zoho.com',
  });
}

const larkCtx = makeCtx('zohoBooks', ['read', 'create', 'update', 'delete'], {
  chatId: 'oc-1',
} as never);

describe('invoices must be staged', () => {
  it('refuses create_invoice with no staging', async () => {
    const result = await makeTool().execute({ op: 'create_invoice', fields: soundPayload } as never, ctx);
    assert.equal(result.ok, false);
    assert.match((result as any).error.payload.message, /needs a stagingId/);
  });

  it('stages without writing anything to Zoho', async () => {
    let mutated = false;
    const store = makeStore();
    const tool = makeTool({ store, booksClient: makeBooksClient(() => { mutated = true; }) });

    const result = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);

    assert.equal(result.ok, true);
    assert.equal(mutated, false, 'staging must not call Zoho');
    assert.ok((result as any).value.stagingId);
    assert.match((result as any).value.stagedSummary, /Retainer/);
  });

  it('will not create a draft the reviewer rejected', async () => {
    const store = makeStore();
    const tool = makeTool({
      store,
      review: {
        outcome: 'fail', reason: 'The amount contradicts what the member said.',
        issues: [{ field: 'amount', problem: 'member said 40000, draft says 50000' }],
        unsourced: [],
      },
    });

    const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const stagingId = (staged as any).value.stagingId;
    assert.equal((staged as any).value.success, false);

    const created = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);
    assert.equal(created.ok, false);
    assert.match((created as any).error.payload.message, /did not pass review/);
  });
});

describe('one approved draft makes one invoice', () => {
  it('refuses to create the same staging twice', async () => {
    let mutations = 0;
    const store = makeStore();
    const tool = makeTool({ store, booksClient: makeBooksClient(() => { mutations += 1; }) });

    const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const stagingId = (staged as any).value.stagingId;

    const first = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);
    const second = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.match((second as any).error.payload.message, /already created as invoice/);
    assert.equal(mutations, 1, 'Zoho must be called exactly once');
  });

  it('hands the draft back only when Zoho proves it wrote nothing', async () => {
    // A validation refusal is the one failure that proves it: Zoho read the
    // payload, rejected it, wrote nothing. That draft has to stay retryable.
    const store = makeStore();
    const rejecting = {
      ...makeBooksClient(),
      mutate: async () => { throw new Error('Zoho Books 400 Bad Request: {"code":4000,"message":"Invalid customer"}'); },
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store, booksClient: rejecting });

    const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const stagingId = (staged as any).value.stagingId;

    const result = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);

    assert.equal(result.ok, false);
    assert.deepEqual(store.calls, ['claim', 'release']);
    assert.equal(store.rows.get(stagingId)?.createdInvoiceId, undefined);
  });

  it('hands the draft back when the write was never dispatched', async () => {
    // A revoked refresh token, a missing connection, an unresolvable
    // organisation: none of these sent a byte. Holding them would strand a
    // draft that never reached Zoho and send the member hunting for an invoice
    // that does not exist.
    for (const failure of [
      new WriteNotDispatchedError('invalid_client'),
      new WriteNotDispatchedError('Zoho connection not found or access denied'),
    ]) {
      const store = makeStore();
      let mutations = 0;
      const failing = {
        ...makeBooksClient(),
        mutate: async () => { mutations += 1; throw failure; },
      } as unknown as ZohoBooksPaginatedClient;
      const tool = makeTool({ store, booksClient: failing });

      const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
      const stagingId = (staged as any).value.stagingId;

      const first = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);
      assert.equal(first.ok, false, failure.message);
      assert.deepEqual(store.calls, ['claim', 'release'], failure.message);
      assert.equal(
        /may already exist/.test(String((first as any).error.payload.message)),
        false,
        'nothing was sent, so nothing may exist',
      );

      // Once the connection is fixed, the same draft must still be creatable.
      const second = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);
      assert.equal(second.ok, false);
      assert.equal(mutations, 2, 'the retry must actually reach Zoho');
    }
  });

  it('refuses to retry a draft whose create never reported back', async () => {
    // A 5xx, a timeout or a dropped socket all leave the same question open:
    // did Zoho write the invoice before the answer was lost? Releasing would
    // answer "no" on the member's behalf and invite the retry that bills twice.
    for (const failure of [
      new Error('Zoho Books 500 Internal Server Error: '),
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
      new Error('fetch failed'),
    ]) {
      const store = makeStore();
      let mutations = 0;
      const failing = {
        ...makeBooksClient(),
        mutate: async () => { mutations += 1; throw failure; },
      } as unknown as ZohoBooksPaginatedClient;
      const tool = makeTool({ store, booksClient: failing });

      const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
      const stagingId = (staged as any).value.stagingId;

      const first = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);
      assert.equal(first.ok, false, failure.message);
      assert.deepEqual(store.calls, ['claim', 'markUnresolved'], failure.message);

      // The retry the error text would otherwise invite must not reach Zoho.
      const second = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);
      assert.equal(second.ok, false);
      assert.match((second as any).error.payload.message, /may already exist in Zoho/);
      assert.equal(mutations, 1, `Zoho must be called once for ${failure.message}`);
    }
  });
});

describe('what Zoho stored versus what was approved', () => {
  it('reports a customer Zoho did not keep', async () => {
    const store = makeStore();
    const drifting = {
      ...makeBooksClient(),
      mutate: async () => ({
        organizationId: 'org-1',
        payload: { invoice: { invoice_id: 'inv-1', status: 'draft', customer_id: '9999999', currency_code: 'INR' } },
      }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store, booksClient: drifting });

    const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const created = await tool.execute(
      { op: 'create_invoice', stagingId: (staged as any).value.stagingId } as never,
      ctx,
    );

    assert.equal(created.ok, true);
    const drift = (created as any).value.drift;
    assert.ok(drift.some((entry: any) => entry.field === 'customer'));
    assert.match((created as any).value.message, /stored some values differently/);
  });
});

describe('a draft is created where it was reviewed', () => {
  it('posts to the organisation it was staged against, not the one the confirming call names', async () => {
    // The draft was checked against one organisation's customers, items and
    // taxes. Creating it elsewhere posts ids that mean something different
    // there — and the drift check cannot see it, because Zoho echoes back the
    // customer_id it was sent.
    const writes: any[] = [];
    const client = {
      ...makeBooksClient(),
      mutate: async (input: any) => {
        writes.push(input);
        return {
          organizationId: input.organizationId,
          payload: { invoice: { invoice_id: 'inv-created', status: 'draft', currency_code: 'INR', customer_id: input.body?.customer_id } },
        };
      },
    } as unknown as ZohoBooksPaginatedClient;
    const store = makeStore();
    const tool = makeTool({ store, booksClient: client });

    const staged = await tool.execute({
      op: 'stage_invoice', fields: soundPayload,
      connectionId: 'conn-a', organizationId: 'ORG-A',
    } as never, ctx);
    const stagingId = (staged as any).value.stagingId;

    // The tool docs tell the model to omit organizationId; doing so must not
    // silently redirect the invoice to the connection's default organisation.
    const created = await tool.execute({
      op: 'create_invoice', stagingId, connectionId: 'conn-a',
    } as never, ctx);

    assert.equal(created.ok, true);
    const post = writes.find(w => w.path === '/invoices');
    assert.equal(post.organizationId, 'ORG-A');
    assert.equal(post.connectionId, 'conn-a');
  });

  it('refuses to create a draft against a different Zoho account', async () => {
    const store = makeStore();
    const tool = makeTool({ store });

    const staged = await tool.execute({
      op: 'stage_invoice', fields: soundPayload,
      connectionId: 'conn-a', organizationId: 'ORG-A',
    } as never, ctx);
    const stagingId = (staged as any).value.stagingId;

    const wrongConnection = await tool.execute({
      op: 'create_invoice', stagingId, connectionId: 'conn-b',
    } as never, ctx);
    const wrongOrg = await tool.execute({
      op: 'create_invoice', stagingId, connectionId: 'conn-a', organizationId: 'ORG-B',
    } as never, ctx);

    assert.equal(wrongConnection.ok, false);
    assert.match((wrongConnection as any).error.payload.message, /different Zoho account/);
    assert.equal(wrongOrg.ok, false);
    assert.match((wrongOrg as any).error.payload.message, /different Zoho organisation/);
    assert.equal(store.calls.includes('claim'), false, 'nothing may be claimed for a refused destination');
  });
});

describe('the file the summary promised', () => {
  const pdf = {
    kind: 'resolved' as const,
    fileName: 'acme-po.pdf',
    mimeType: 'application/pdf',
    content: Buffer.from('%PDF-1.4'),
  };

  it('attaches it after creating, and says what Zoho confirms', async () => {
    const writes: any[] = [];
    const client = {
      ...makeBooksClient(),
      mutate: async (input: any) => {
        writes.push(input);
        return {
          organizationId: 'org-1',
          payload: { invoice: { invoice_id: 'inv-created', status: 'draft', currency_code: 'INR', customer_id: input.body?.customer_id } },
        };
      },
      getEndpoint: async () => (writes.some(w => String(w.path).includes('/attachment'))
        ? { invoice: { invoice_id: 'inv-created', documents: [{ file_name: 'acme-po.pdf' }] } }
        : { invoice: { invoice_id: 'inv-created', documents: [] } }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ booksClient: client, attachmentSource: { resolve: async () => pdf } });

    const staged = await tool.execute({
      op: 'stage_invoice', fields: soundPayload, fileName: 'acme-po.pdf',
    } as never, larkCtx);
    assert.match((staged as any).value.stagedSummary, /Attachment: acme-po\.pdf/);

    const created = await tool.execute({
      op: 'create_invoice', stagingId: (staged as any).value.stagingId,
    } as never, larkCtx);

    assert.equal(created.ok, true);
    assert.ok(writes.some(w => String(w.path).includes('/attachment')), 'the approved file must be attached');
    assert.match((created as any).value.message, /Attached "acme-po\.pdf"/);
  });

  it('says the invoice stands without its file when the attachment fails', async () => {
    // The member approved a summary promising the file. Silence here would let
    // them assume it landed.
    const tool = makeTool({
      attachmentSource: { resolve: async () => ({ kind: 'unavailable', message: 'No file called "acme-po.pdf" was sent in this conversation.' }) },
    });

    const staged = await tool.execute({
      op: 'stage_invoice', fields: soundPayload, fileName: 'acme-po.pdf',
    } as never, larkCtx);
    const created = await tool.execute({
      op: 'create_invoice', stagingId: (staged as any).value.stagingId,
    } as never, larkCtx);

    assert.equal(created.ok, true);
    assert.match((created as any).value.message, /not confirmed on it/);
    assert.match((created as any).value.message, /No file called/);
  });
});

describe('a number that is already in use', () => {
  it('blocks a draft whose invoice number Zoho already has', async () => {
    // create_invoice sets ignore_auto_number_generation when a number is
    // supplied, so this is the one path where a repeat can reach the books.
    const client = {
      ...makeBooksClient(),
      listRecords: async ({ moduleName }: any) => ({
        organizationId: 'org-1',
        items: moduleName === 'invoices'
          ? [{ invoice_id: 'inv-existing', invoice_number: 'EMI/2026/114' }]
          : [],
        hasMore: false, page: 1,
      }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ booksClient: client });

    const staged = await tool.execute({
      op: 'stage_invoice',
      fields: { ...soundPayload, invoice_number: 'EMI/2026/114' },
    } as never, ctx);

    assert.equal((staged as any).value.success, false);
    assert.match((staged as any).value.stagedSummary, /EMI\/2026\/114 is already used by inv-existing/);
  });
});

describe('verifying an attachment follows the write', () => {
  it('confirms the file in the organisation the invoice was created in', async () => {
    // The upload went to the staged organisation; a verification read against
    // the connection's default one 404s and reports a file that did land as
    // missing.
    let uploaded = false;
    const client = {
      ...makeBooksClient(),
      mutate: async (input: any) => {
        if (String(input.path).includes('/attachment')) {
          // The upload must itself go to the staged organisation.
          assert.equal(input.organizationId, 'ORG-A');
          uploaded = true;
          return { organizationId: input.organizationId, payload: {} };
        }
        return {
          organizationId: input.organizationId,
          payload: { invoice: { invoice_id: 'inv-created', status: 'draft', currency_code: 'INR' } },
        };
      },
      getEndpoint: async (input: any) => {
        // The read has to follow the write, or a file that landed reads as missing.
        if (input.organizationId !== 'ORG-A') throw new Error('Zoho Books 404 Not Found: invoice does not exist');
        return {
          invoice: {
            invoice_id: 'inv-created',
            documents: uploaded ? [{ file_name: 'acme-po.pdf' }] : [],
          },
        };
      },
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({
      booksClient: client,
      attachmentSource: {
        resolve: async () => ({
          kind: 'resolved' as const,
          fileName: 'acme-po.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('%PDF-1.4'),
        }),
      },
    });

    const staged = await tool.execute({
      op: 'stage_invoice', fields: soundPayload, fileName: 'acme-po.pdf',
      connectionId: 'conn-a', organizationId: 'ORG-A',
    } as never, larkCtx);

    // organizationId omitted on the confirming call, as the tool docs instruct.
    const created = await tool.execute({
      op: 'create_invoice', stagingId: (staged as any).value.stagingId, connectionId: 'conn-a',
    } as never, larkCtx);

    assert.equal(created.ok, true);
    assert.match((created as any).value.message, /Attached "acme-po\.pdf"/);
  });

  it('does not call an accepted upload a failed one, or invite a blind retry', async () => {
    // The POST succeeded and only the verification read failed. Saying the
    // record is unchanged would invite a retry, and Zoho appends rather than
    // replaces — the same PDF twice.
    let attachments = 0;
    const client = {
      ...makeBooksClient(),
      mutate: async (input: any) => {
        if (String(input.path).includes('/attachment')) { attachments += 1; return { organizationId: 'org-1', payload: {} }; }
        return { organizationId: 'org-1', payload: { invoice: { invoice_id: 'inv-created', status: 'draft', currency_code: 'INR' } } };
      },
      getEndpoint: async () => { throw new Error('Zoho Books 503 Service Unavailable: '); },
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({
      booksClient: client,
      attachmentSource: {
        resolve: async () => ({
          kind: 'resolved' as const,
          fileName: 'po.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('%PDF-1.4'),
        }),
      },
    });

    const result = await tool.execute({
      op: 'attach_document', recordType: 'invoice', recordId: 'inv-1', fileName: 'po.pdf',
    } as never, larkCtx);

    assert.equal(result.ok, true, 'an accepted upload is not a refusal');
    assert.equal((result as any).value.success, false, 'but it is not confirmed either');
    assert.equal(
      /itself is unchanged/.test((result as any).value.message),
      false,
      'the upload was accepted, so the record may well have changed',
    );
    assert.match((result as any).value.message, /Do not upload it again/);
    assert.equal(attachments, 1);
  });
});
