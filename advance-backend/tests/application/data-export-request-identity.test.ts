import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dataExportCallRequestId,
  dataExportRunRequestId,
} from '../../src/application/data-export/export-request-identity.ts';
import {
  dataExportJobId,
  dataExportOfferKey,
} from '../../src/application/data-export/data-export.queue.ts';
import type { DataExportJobPayload } from '../../src/application/data-export/data-export.types.ts';

describe('data export request identity', () => {
  it('scopes a merged offer to the run and a direct submit to the call', () => {
    assert.equal(
      dataExportRunRequestId({ runtimeRunId: 'run-1', requestId: 'toolcall-7' }, 'corr'),
      'run-1',
    );
    assert.equal(dataExportRunRequestId({ requestId: 'toolcall-7' }, 'corr'), 'toolcall-7');
    assert.equal(dataExportRunRequestId({}, 'corr'), 'corr');
    // A direct submit must ignore the run lease, or the second one in a run
    // collides with the first.
    assert.equal(
      dataExportCallRequestId({ runtimeRunId: 'run-1', requestId: 'toolcall-7' } as never, 'corr'),
      'toolcall-7',
    );
    assert.equal(dataExportCallRequestId({}, 'corr'), 'corr');
  });

  it('gives every tool call in one run the same offer key', () => {
    // The runtime sets `requestId` from the tool call id, so two provider calls
    // in one run arrive with different ones. Deriving the offer key from that
    // gave each call its own offer: nothing ever appended, and the member was
    // shown a button covering whichever call ran last.
    const base = {
      companyId: 'company-1',
      userId: 'user-1',
      destination: { format: 'auto', title: 'Report' },
      chatId: 'oc_test',
      source: {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'domain_overview', domain: 'a.com' },
      },
    } as const;
    const runContext = { runtimeRunId: 'run-1' };

    const firstCall: DataExportJobPayload = {
      ...base,
      requestId: dataExportRunRequestId({ ...runContext, requestId: 'toolcall-1' }, 'corr-1'),
    };
    const secondCall: DataExportJobPayload = {
      ...base,
      source: { ...base.source, args: { operation: 'domain_overview', domain: 'b.com' } },
      requestId: dataExportRunRequestId({ ...runContext, requestId: 'toolcall-2' }, 'corr-2'),
    };

    assert.equal(dataExportOfferKey(firstCall), dataExportOfferKey(secondCall));
  });

  it('keeps separate runs on separate offers', () => {
    const base = {
      companyId: 'company-1',
      userId: 'user-1',
      destination: { format: 'auto', title: 'Report' },
      chatId: 'oc_test',
      source: {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'domain_overview', domain: 'a.com' },
      },
    } as const;
    assert.notEqual(
      dataExportOfferKey({ ...base, requestId: dataExportRunRequestId({ runtimeRunId: 'run-1' }, 'corr') }),
      dataExportOfferKey({ ...base, requestId: dataExportRunRequestId({ runtimeRunId: 'run-2' }, 'corr') }),
    );
  });

  it('keeps two direct submits in one run on separate offers and jobs', () => {
    // `submitAuthorized` has no merge step: a shared offer key makes
    // `offers.create` answer `existing`, and `assertSameRequest` then rejects
    // the whole request. "Export all my invoices and all my bills" would queue
    // the invoices and fail outright on the bills.
    const runContext = { runtimeRunId: 'run-1' };
    const base = {
      companyId: 'company-1',
      userId: 'user-1',
      destination: { format: 'auto', title: 'Zoho' },
      chatId: 'oc_test',
    } as const;
    const invoices: DataExportJobPayload = {
      ...base,
      source: { kind: 'zoho_books', connectionId: '11111111-1111-4111-8111-111111111111', module: 'invoices' },
      requestId: dataExportCallRequestId({ ...runContext, requestId: 'toolcall-1' } as never, 'corr-1'),
    };
    const bills: DataExportJobPayload = {
      ...base,
      source: { kind: 'zoho_books', connectionId: '11111111-1111-4111-8111-111111111111', module: 'bills' },
      requestId: dataExportCallRequestId({ ...runContext, requestId: 'toolcall-2' } as never, 'corr-2'),
    };

    assert.notEqual(dataExportOfferKey(invoices), dataExportOfferKey(bills));
    assert.notEqual(dataExportJobId(invoices), dataExportJobId(bills));
  });
});
