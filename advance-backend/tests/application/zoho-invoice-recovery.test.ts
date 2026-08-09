/**
 * Deciding what a lost answer means, without asking a person to remember.
 *
 * Two pure questions sit under the recovery path: what a failure proves about
 * Zoho's books, and whether an invoice already in Zoho is the one a draft would
 * have created. Both are decided here, so the tool only has to act on them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWriteFailure,
  matchStagedInvoice,
  stagedInvoiceSearchWindow,
} from '../../src/application/zoho/zoho-invoice-staging.ts';
import { checkInvoice } from '../../src/application/zoho/zoho-invoice-checks.ts';
import { WriteNotDispatchedError } from '../../src/shared/errors.ts';

describe('what a failed write proves', () => {
  it('separates never-sent from refused from unknown', () => {
    const cases: [unknown, string][] = [
      [new WriteNotDispatchedError('no connection'),            'not_dispatched'],
      [new Error('Zoho Books 400 Bad Request: bad customer'),   'rejected'],
      [new Error('Zoho Books 401 Unauthorized: '),              'rejected'],
      [new Error('Zoho Books 404 Not Found: '),                 'rejected'],
      // Dispatched, and the answer lost. The invoice may exist.
      [new Error('Zoho Books 500 Internal Server Error: '),     'unknown'],
      [new Error('Zoho Books 503 Service Unavailable: '),       'unknown'],
      [new Error('Zoho Books 408 Request Timeout: '),           'unknown'],
      [new Error('Zoho Books 429 Too Many Requests: '),         'unknown'],
      [new Error('fetch failed'),                               'unknown'],
    ];
    for (const [error, kind] of cases) {
      assert.equal(classifyWriteFailure(error).kind, kind, String(error));
    }
  });

  it('gives every case a reason a member could be told', () => {
    for (const error of [
      new WriteNotDispatchedError('the Zoho connection was revoked'),
      new Error('Zoho Books 429 Too Many Requests: '),
      new Error('fetch failed'),
    ]) {
      assert.ok(classifyWriteFailure(error).why.length > 10, String(error));
    }
  });

  it('never reports a pre-flight failure as possibly-written', () => {
    // The regression that mattered: a revoked refresh token read as "your
    // invoice may exist, go and look for it" strands the draft permanently and
    // sends someone hunting for something that was never sent.
    assert.notEqual(classifyWriteFailure(new WriteNotDispatchedError('revoked')).kind, 'unknown');
    assert.equal(classifyWriteFailure(new Error('Zoho Books 500 Internal Server Error: ')).kind, 'unknown');
  });
});

describe('recognising an invoice a draft would have created', () => {
  const staged = {
    payload: {
      customer_id: '1500001',
      date: '2026-08-01',
      line_items: [{ name: 'Retainer', quantity: 1, rate: 50000 }],
    },
  };

  it('matches on customer, line count and pre-tax total', () => {
    assert.equal(matchStagedInvoice(staged, {
      customer_id: '1500001', sub_total: '50000.00',
      line_items: [{ name: 'Retainer', quantity: 1, rate: 50000 }],
    }), 'match');
  });

  it('rules out a different customer billed the same amount', () => {
    assert.equal(matchStagedInvoice(staged, {
      customer_id: '1500002', sub_total: '50000.00',
      line_items: [{ name: 'Retainer', quantity: 1, rate: 50000 }],
    }), 'no');
  });

  it('will not rule out the same customer billed a different amount', () => {
    // Could be a different invoice, could be this one after a price list was
    // applied. This cannot tell, and only 'no' is dangerous.
    assert.equal(matchStagedInvoice(staged, {
      customer_id: '1500001', sub_total: '75000.00',
      line_items: [{ name: 'Retainer', quantity: 1, rate: 75000 }],
    }), 'undecidable');
  });

  it('says undecidable for a Zoho list row, which carries no amount to compare', () => {
    // Verified against the live API: invoice list rows have `total` but neither
    // `sub_total` nor `line_items`. Answering 'no' here would report an invoice
    // that does exist as absent, and authorise billing the customer twice.
    assert.equal(matchStagedInvoice(staged, {
      invoice_id: 'inv-1', customer_id: '1500001', invoice_number: 'INV-77',
      date: '2026-08-01', status: 'draft', total: 59000, balance: 59000,
    }), 'undecidable');
  });

  it('lets a number decide only when both sides carry one', () => {
    const numbered = { payload: { ...staged.payload, invoice_number: 'EMI/2026/114' } };
    assert.equal(matchStagedInvoice(numbered, {
      customer_id: '1500001', invoice_number: 'EMI/2026/114', sub_total: '1.00', line_items: [],
    }), 'match');
    assert.equal(matchStagedInvoice(numbered, {
      customer_id: '1500001', invoice_number: 'EMI/2026/115',
      sub_total: '50000.00', line_items: [{ name: 'Retainer', quantity: 1, rate: 50000 }],
    }), 'no');
    // A numbered first attempt against an unnumbered re-stage of the same
    // invoice: comparing number-to-blank used to say 'no' and miss the twin.
    assert.equal(matchStagedInvoice(numbered, {
      customer_id: '1500001', sub_total: '50000.00',
      line_items: [{ name: 'Retainer', quantity: 1, rate: 50000 }],
    }), 'match');
  });

  it('will not rule out an invoice Zoho repriced on the way in', () => {
    // Zoho applies customer price lists and line discounts to what it is sent.
    // That is why a drift check exists at all — so a stored amount that differs
    // from the sent amount is normal, and reading it as "a different invoice"
    // reports the real one absent and authorises billing the customer twice.
    assert.notEqual(matchStagedInvoice(staged, {
      invoice_id: 'inv-landed', customer_id: '1500001', sub_total: '45000.00',
      line_items: [{ name: 'Retainer', quantity: 1, rate: 50000, discount: '10%', item_total: 45000 }],
    }), 'no');
  });

  it('matches on list price, not on what Zoho decided the line costs', () => {
    assert.equal(matchStagedInvoice(staged, {
      customer_id: '1500001', sub_total: '45000.00',
      line_items: [{ quantity: 1, rate: 50000, discount: '10%', item_total: 45000 }],
    }), 'match');
  });

  it('will not decide about a draft that names no customer', () => {
    assert.equal(matchStagedInvoice({ payload: { line_items: [] } }, { customer_id: '1500001' }), 'undecidable');
  });
});

describe('where to look for it', () => {
  const now = new Date('2026-08-08T10:00:00.000Z');

  it('opens a day before the draft date and stays open to today', () => {
    const window = stagedInvoiceSearchWindow(
      { payload: { customer_id: '1500001', date: '2026-08-01' } }, now,
    );
    assert.deepEqual(window, { customerId: '1500001', dateStart: '2026-07-31', dateEnd: '2026-08-09' });
  });

  it('anchors an undated draft on when it was staged, not on now', () => {
    // Zoho dated the invoice on the day the write went out. Centring on `now`
    // searched days the invoice was never in, and reported it absent.
    const window = stagedInvoiceSearchWindow(
      { payload: { customer_id: '1500001' }, createdAt: new Date('2026-08-05T09:00:00.000Z') },
      now,
    );
    assert.equal(window?.dateStart, '2026-08-04');
    assert.equal(window?.dateEnd, '2026-08-09');
  });

  it('uses today for a draft with no date and no staging time', () => {
    const window = stagedInvoiceSearchWindow({ payload: { customer_id: '1500001' } }, now);
    assert.deepEqual(window, { customerId: '1500001', dateStart: '2026-08-07', dateEnd: '2026-08-09' });
  });

  it('declines to search at all without a customer to narrow by', () => {
    // Zoho answers a filter it does not recognise with the unfiltered list, so
    // a lookup with nothing usable to filter on would read everything and
    // prove nothing.
    assert.equal(stagedInvoiceSearchWindow({ payload: { date: '2026-08-01' } }, now), null);
  });
});

describe('a duplicate check that could not run', () => {
  const invoice = {
    customer_id: '1500001',
    invoice_number: 'EMI/2026/114',
    line_items: [{ name: 'Retainer', quantity: 1, rate: 50000 }],
  };

  it('says so, rather than reporting the number free', () => {
    const findings = checkInvoice({ invoice, sameNumberInvoices: [], duplicateCheckUnavailable: true });
    const finding = findings.find(f => f.code === 'duplicate_check_unavailable');
    assert.ok(finding, 'a failed lookup must be visible to the member');
    assert.equal(finding.severity, 'warning');
  });

  it('stays quiet when the lookup ran and found nothing', () => {
    const findings = checkInvoice({ invoice, sameNumberInvoices: [], duplicateCheckUnavailable: false });
    assert.equal(findings.some(f => f.code === 'duplicate_check_unavailable'), false);
  });

  it('stays quiet when Zoho is assigning the number itself', () => {
    // No number supplied means Zoho's own numbering is in force, and there is
    // nothing for a duplicate check to have failed at.
    const { invoice_number: _omitted, ...autoNumbered } = invoice;
    const findings = checkInvoice({ invoice: autoNumbered, duplicateCheckUnavailable: true });
    assert.equal(findings.some(f => f.code === 'duplicate_check_unavailable'), false);
  });
});
