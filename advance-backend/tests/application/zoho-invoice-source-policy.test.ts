import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyInvoiceSourcePolicy,
  dateInTimeZone,
} from '../../src/application/zoho/zoho-invoice-source-policy.ts';

const vasanCustomer = {
  contact_id: 'customer-1',
  contact_name: 'VASAN HEALTH CARE PRIVATE LIMITED',
  billing_address: {
    address_id: 'wrong-default',
    address: '15 - A, First Floor B Block, THILLAI NAGAR MAIN ROAD',
    street2: 'THILLAI NAGARTRICHY',
    city: 'Tiruchirappalli',
    zip: '620018',
    country: 'India',
  },
  addresses: [
    {
      address_id: 'correct-po-address',
      address: 'No: 10, Annamalai Nagar, Thillai Nagar,\nTrichy, Tamilnadu',
      city: 'Trichy',
      state: 'Tamil Nadu',
      zip: '620018',
      country: 'India',
    },
  ],
};

const quote = `
Quote #EST4387
Bill To
VASAN HEALTH CARE PRIVATE LIMITED
No: 10, Annamalai Nagar, Thillai Nagar,
Trichy, Tamilnadu
Trichy
620018 Tamil Nadu
India
Quote Date: 10-08-2026
`;

describe('invoice source policy', () => {
  it('reproduces the VASAN incident and selects the source address explicitly', () => {
    const result = applyInvoiceSourcePolicy({
      payload: {
        customer_id: 'customer-1',
        date: '2026-08-10',
        due_date: '2026-09-09',
        line_items: [{ name: 'Guest posting', quantity: 1, rate: 98_800 }],
      },
      sourceDocument: { fileName: 'EST4387.pdf', text: quote },
      chosenCustomer: vasanCustomer,
      now: new Date('2026-08-15T20:30:00.000Z'),
      organizationTimeZone: 'Asia/Kolkata',
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    // 20:30Z is already the next accounting day in India.
    assert.equal(result.payload['date'], '2026-08-16');
    assert.equal(result.payload['due_date'], '2026-09-15');
    assert.equal(result.payload['billing_address_id'], 'correct-po-address');
    assert.equal(result.sourcePolicy.billingAddress?.addressId, 'correct-po-address');
    assert.match(result.notes.join(' '), /Quote date 2026-08-10 kept as source evidence/);
  });

  it('refuses to let Zoho silently use a default when Bill To matches no saved address', () => {
    const result = applyInvoiceSourcePolicy({
      payload: { customer_id: 'customer-1', date: '2026-08-10' },
      sourceDocument: {
        fileName: 'quote.pdf',
        text: 'Quote\nBill To\nVASAN HEALTH CARE\nCompletely Different Road, Bengaluru 560001',
      },
      chosenCustomer: vasanCustomer,
      now: new Date('2026-08-15T10:00:00.000Z'),
      organizationTimeZone: 'Asia/Kolkata',
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /does not uniquely match a saved address/i);
  });

  it('refuses an explicitly selected address that contradicts the document', () => {
    const result = applyInvoiceSourcePolicy({
      payload: {
        customer_id: 'customer-1',
        date: '2026-08-10',
        billing_address_id: 'wrong-default',
      },
      sourceDocument: { fileName: 'EST4387.pdf', text: quote },
      chosenCustomer: vasanCustomer,
      now: new Date('2026-08-15T10:00:00.000Z'),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /does not match the Bill To address/i);
  });

  it('dates even a new invoice copied from an old invoice on its creation day', () => {
    const result = applyInvoiceSourcePolicy({
      payload: { customer_id: 'customer-1', date: '2026-08-10' },
      sourceDocument: { fileName: 'invoice.pdf', text: 'Tax Invoice\nInvoice Date: 2026-08-10' },
      now: new Date('2026-08-15T10:00:00.000Z'),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload['date'], '2026-08-15');
    assert.equal(result.sourcePolicy.documentKind, undefined);
  });

  it('dates a new invoice on its creation day even when there is no document', () => {
    const result = applyInvoiceSourcePolicy({
      payload: {
        customer_id: 'customer-1',
        date: '2026-08-10',
        due_date: '2026-09-09',
      },
      now: new Date('2026-08-15T10:00:00.000Z'),
      organizationTimeZone: 'Asia/Kolkata',
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload['date'], '2026-08-15');
    assert.equal(result.payload['due_date'], '2026-09-14');
  });

  it('uses the Zoho organisation timezone for the creation day', () => {
    const now = new Date('2026-08-15T20:30:00.000Z');
    assert.equal(dateInTimeZone(now, 'UTC'), '2026-08-15');
    assert.equal(dateInTimeZone(now, 'Asia/Kolkata'), '2026-08-16');
  });
});
