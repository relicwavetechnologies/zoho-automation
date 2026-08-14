import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyZohoBooksWriteFailure,
  createZohoBooksWriteRunner,
} from '../../src/application/zoho/zoho-books-write.ts';
import { WriteNotDispatchedError } from '../../src/shared/errors.ts';
import type { ZohoBooksPaginatedClient } from '../../src/infrastructure/zoho/zoho-books-paginated.client.ts';

describe('Zoho Books write runner', () => {
  it('writes through the client and returns the stored record summary', async () => {
    let captured: unknown;
    const booksClient = {
      mutate: async (input: unknown) => {
        captured = input;
        return {
          organizationId: 'org-1',
          payload: {
            bill: {
              bill_id: 'bill-1',
              bill_number: 'B-1',
              status: 'open',
              total: '100.00',
              balance: '100.00',
              currency_code: 'INR',
            },
          },
        };
      },
    } as unknown as ZohoBooksPaginatedClient;

    const writer = createZohoBooksWriteRunner({
      booksClient,
      companyId: 'co-1',
      userId: 'user-1',
      connectionId: 'conn-1',
      organizationId: 'org-default',
      appBaseUrl: 'https://books.zoho.com',
    });

    const written = await writer.writeRecord({
      module: 'bills',
      verb: 'created',
      method: 'POST',
      path: '/bills',
      organizationId: 'org-1',
      body: { bill_number: 'B-1' },
    });

    assert.deepEqual(captured, {
      companyId: 'co-1',
      userId: 'user-1',
      connectionId: 'conn-1',
      method: 'POST',
      path: '/bills',
      organizationId: 'org-1',
      body: { bill_number: 'B-1' },
    });
    assert.equal(written.record['bill_id'], 'bill-1');
    assert.equal(written.summary.id, 'bill-1');
    assert.match(written.summary.message, /Bill B-1 created in Zoho Books/);
    assert.equal(written.summary.recordUrl, 'https://books.zoho.com/app/org-1#/bills/bill-1');
  });
});

describe('Zoho Books write failure classification', () => {
  it('separates unsent, refused, and uncertain provider writes', () => {
    assert.equal(classifyZohoBooksWriteFailure(new WriteNotDispatchedError('revoked')).kind, 'not_dispatched');
    assert.equal(classifyZohoBooksWriteFailure(new Error('Zoho Books 400 Bad Request: bad vendor')).kind, 'rejected');
    assert.equal(classifyZohoBooksWriteFailure(new Error('Zoho Books 500 Internal Server Error:')).kind, 'unknown');
    assert.equal(classifyZohoBooksWriteFailure(new Error('fetch failed')).kind, 'unknown');
  });

  it('keeps the document name in the uncertainty explanation', () => {
    const failure = classifyZohoBooksWriteFailure(
      new Error('Zoho Books 503 Service Unavailable:'),
      { receivedObject: 'the purchase order' },
    );

    assert.equal(failure.kind, 'unknown');
    assert.match(failure.why, /purchase order/);
  });
});
