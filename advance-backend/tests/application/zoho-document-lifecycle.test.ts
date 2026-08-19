import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  completeZohoDocument,
  writeZohoDocument,
  type ZohoDocumentWriter,
} from '../../src/application/zoho/zoho-document-lifecycle.ts';
import type { ZohoBooksWrittenRecord } from '../../src/application/zoho/zoho-books-write.ts';

const written = (id: string): ZohoBooksWrittenRecord => ({
  organizationId: 'org-1',
  record: { invoice_id: id },
  summary: {
    id,
    message: 'Invoice created in Zoho Books.',
    documents: [],
  },
});

const request = {
  module: 'invoices' as const,
  verb: 'created',
  method: 'POST' as const,
  path: '/invoices',
  body: { customer_id: 'customer-1' },
};

describe('Zoho document lifecycle write seam', () => {
  it('returns a created outcome with the provider write intact', async () => {
    let received: unknown;
    const writer: ZohoDocumentWriter = {
      writeRecord: async input => {
        received = input;
        return written('invoice-1');
      },
    };

    const outcome = await writeZohoDocument({
      writer,
      request,
      receivedObject: 'the invoice',
    });

    assert.deepEqual(received, request);
    assert.deepEqual(outcome, { kind: 'created', written: written('invoice-1') });
  });

  it('keeps an accepted response without an id in the unsafe outcome', async () => {
    const writer: ZohoDocumentWriter = {
      writeRecord: async () => ({
        organizationId: 'org-1',
        record: { invoice_number: 'INV-1' },
        summary: { id: '', message: 'accepted', documents: [] },
      }),
    };

    const outcome = await writeZohoDocument({
      writer,
      request,
      receivedObject: 'the invoice',
    });

    assert.equal(outcome.kind, 'missing_id');
  });

  it('classifies a provider rejection as safe to release', async () => {
    const writer: ZohoDocumentWriter = {
      writeRecord: async () => {
        throw new Error('Zoho Books 400: invalid invoice number');
      },
    };

    const outcome = await writeZohoDocument({
      writer,
      request,
      receivedObject: 'the invoice',
    });

    assert.equal(outcome.kind, 'failed');
    if (outcome.kind !== 'failed') return;
    assert.equal(outcome.failure.kind, 'rejected');
    assert.equal(outcome.failure.status, 400);
  });

  it('classifies a provider timeout as unsafe to retry', async () => {
    const writer: ZohoDocumentWriter = {
      writeRecord: async () => {
        throw new Error('Zoho Books 502: upstream timeout');
      },
    };

    const outcome = await writeZohoDocument({
      writer,
      request,
      receivedObject: 'the invoice',
    });

    assert.equal(outcome.kind, 'failed');
    if (outcome.kind !== 'failed') return;
    assert.equal(outcome.failure.kind, 'unknown');
  });

  it('settles, attaches, and verifies in that order', async () => {
    const events: string[] = [];
    const writer = {
      writeRecord: async () => written('invoice-1'),
      verifyRecord: async () => {
        events.push('verify');
        return {
          record: { invoice_id: 'invoice-1', status: 'draft' },
          summary: written('invoice-1').summary,
          verified: true,
          message: 'Invoice verified.',
        };
      },
    };

    const completed = await completeZohoDocument({
      writer,
      module: 'invoices',
      verb: 'created',
      written: written('invoice-1'),
      settle: async () => { events.push('settle'); },
      attach: async () => {
        events.push('attach');
        return { outcome: 'attached' as const, message: 'Attached invoice.pdf.' };
      },
    });

    assert.deepEqual(events, ['settle', 'attach', 'verify']);
    assert.equal(completed.attachment?.outcome, 'attached');
    assert.equal(completed.verification.verified, true);
  });
});
