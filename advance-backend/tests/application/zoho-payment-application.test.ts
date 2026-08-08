/**
 * A payment that settles nothing.
 *
 * Zoho accepts a customer payment with no invoice named and books it as an
 * on-account advance: it answers 201, the invoice keeps its full balance, and
 * the customer is chased for money they have already paid. That is what
 * happened in production — ₹59,000 recorded, `unused_amount` ₹59,000,
 * `invoices: []`, and Divo reported success.
 *
 * These exercise the tool's own guard rather than the Zoho call, so they pin
 * the two things it must never do again: dispatch a payment that applies to
 * nothing, and describe a part-applied payment as settled.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createZohoBooksTool } from '../../src/application/tools/families/zoho-books.tool.ts';
import { makeCtx } from '../tools/tool-test.helpers.ts';

const ctx = makeCtx('zohoBooks');

/** Captures what would have been sent, and answers as Zoho does. */
const makeTool = (paymentResponse: Record<string, unknown>) => {
  const sent: Array<Record<string, unknown>> = [];
  const booksClient: any = {
    async mutate(input: any) {
      sent.push(input.body);
      return { organizationId: 'org-1', payload: { payment: paymentResponse } };
    },
    async listOrganizations() { return [{ organizationId: 'org-1', isDefault: true, stateCode: 'RJ' }]; },
    async resolveOrganizationId() { return 'org-1'; },
  };
  const tool = createZohoBooksTool({ booksClient } as any);
  return { tool, sent };
};

const run = async (fields: Record<string, unknown>, response: Record<string, unknown> = {}) => {
  const { tool, sent } = makeTool({ payment_id: 'pay-1', ...response });
  const result: any = await tool.execute(
    { op: 'record_payment', connectionId: 'conn-1', fields } as any,
    ctx,
  );
  return { result, sent };
};

describe('a customer payment has to settle something', () => {
  it('refuses a payment that names no invoice', async () => {
    const { result, sent } = await run({ customer_id: 'cust-1', amount: 59000 });
    assert.equal(result.ok, false);
    assert.match(result.error.payload.message, /unapplied credit/i);
    // Nothing may reach Zoho: a rejected payment that was still sent is worse
    // than one that was never checked.
    assert.equal(sent.length, 0);
  });

  it('refuses the shape that stranded the money — a bare invoice_id', async () => {
    // Zoho ignores a top-level invoice_id on a payment. It looks right and does
    // nothing, which is the whole reason this guard exists.
    const { result } = await run({ customer_id: 'cust-1', amount: 59000, invoice_id: 'inv-1' });
    assert.equal(result.ok, false);
  });

  it('accepts a payment that applies to an invoice', async () => {
    const { result, sent } = await run(
      { customer_id: 'cust-1', amount: 59000, invoices: [{ invoice_id: 'inv-1', amount_applied: 59000 }] },
      { unused_amount: 0 },
    );
    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!['invoices'], [{ invoice_id: 'inv-1', amount_applied: 59000 }]);
  });

  it('allows a genuine advance only when it is declared', async () => {
    const { result, sent } = await run(
      { customer_id: 'cust-1', amount: 25000, on_account: true },
      { unused_amount: 25000 },
    );
    assert.equal(result.ok, true);
    // `on_account` is ours for saying "yes, really unapplied" — Zoho has never
    // heard of it and must not receive it.
    assert.equal(sent[0]!['on_account'], undefined);
  });

  it('says so when Zoho leaves part of the payment unapplied', async () => {
    // Half-settling an invoice and settling it are different outcomes, and only
    // the tool can tell them apart — the caller asked for the same thing.
    const { result } = await run(
      { customer_id: 'cust-1', amount: 59000, invoices: [{ invoice_id: 'inv-1', amount_applied: 30000 }] },
      { unused_amount: 29000 },
    );
    assert.equal(result.ok, true);
    assert.match(result.value.message, /unapplied/i);
    assert.match(result.value.message, /29,000/);
  });

  it('stays quiet when the payment applied in full', async () => {
    const { result } = await run(
      { customer_id: 'cust-1', amount: 59000, invoices: [{ invoice_id: 'inv-1', amount_applied: 59000 }] },
      { unused_amount: 0 },
    );
    assert.doesNotMatch(result.value.message ?? '', /unapplied/i);
  });
});
