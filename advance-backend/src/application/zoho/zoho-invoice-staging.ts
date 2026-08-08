/**
 * An invoice that does not exist yet.
 *
 * Nothing is written to Zoho until someone has seen what is about to be
 * written. The payload is held here, checked, reviewed by a reader with no
 * knowledge of how it was assembled, rendered into a sentence a person can
 * disagree with, and only then posted.
 *
 * The reason the payload is *stored* rather than passed back through the model
 * is the whole point of the mechanism: creation replays the staged payload, so
 * what the member was shown and what Zoho receives cannot drift apart. A model
 * that showed one invoice and created another would be the exact failure this
 * is meant to prevent, and no amount of instruction rules it out.
 *
 * This is not an approval gate. Nothing here blocks creation or asks a manager.
 * It makes the honest path the easy one, and makes the dishonest one
 * impossible to express.
 */

import { formatAmount } from './zoho-format.utils';
import {
  derivedLineTotal,
  invoiceLineItems,
  type InvoiceFinding,
} from './zoho-invoice-checks';
import type { InvoiceReviewVerdict } from './zoho-invoice-reviewer';

export interface StagedInvoice {
  readonly stagingId: string;
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly organizationId?: string | undefined;
  readonly payload: Record<string, unknown>;
  /** Exactly what the member reads before saying yes. */
  readonly summary: string;
  /** Filename the member sent that should end up on the invoice once created. */
  readonly attachFileName?: string | undefined;
  readonly findings: readonly InvoiceFinding[];
  readonly review: InvoiceReviewVerdict;
  readonly attempt: number;
  /** The draft this one corrects, when it is a retry. */
  readonly supersedesId?: string | undefined;
  readonly createdInvoiceId?: string | undefined;
  readonly expiresAt: Date;
}

export const STAGED_INVOICE_TTL_MS = 24 * 60 * 60_000;

/**
 * Two corrections, then a person.
 *
 * A third round of the same argument between a builder and a reviewer almost
 * never lands somewhere the second did not, and every round spends a real model
 * call while the member waits. Exhausting it is not a failure state to hide:
 * the draft and the reviewer's objection go to the member as they are.
 */
export const MAX_INVOICE_FIX_ATTEMPTS = 2;

/** Held while a create is in flight. */
export const INVOICE_CLAIM_PENDING = 'pending:';

/**
 * Held when a create failed in a way that cannot prove it failed.
 *
 * A timeout, a dropped socket or a 5xx all leave the same question open: did
 * Zoho write the invoice before the answer was lost? Releasing the claim would
 * answer "no" on the member's behalf and invite a retry that bills them twice.
 * This says "nobody knows" and refuses to send it again.
 */
export const INVOICE_CLAIM_UNRESOLVED = 'unknown:';

export interface StagedInvoiceStore {
  put(staged: StagedInvoice): Promise<void>;
  get(input: { stagingId: string; companyId: string; userId: string }): Promise<StagedInvoice | null>;
  claim(input: { stagingId: string; companyId: string; marker: string }): Promise<{ claimed: boolean; heldBy?: string }>;
  settle(input: { stagingId: string; companyId: string; invoiceId: string }): Promise<void>;
  release(input: { stagingId: string; companyId: string; marker: string }): Promise<void>;
  /** Replaces an in-flight claim with a state no retry may clear. */
  markUnresolved(input: { stagingId: string; companyId: string; marker: string; unresolved: string }): Promise<void>;
}

/**
 * Whether a failed write provably never reached Zoho's books.
 *
 * Only a validation refusal proves it: Zoho read the payload, rejected it, and
 * wrote nothing. A 5xx, a 408, a 429 or a transport error all leave open that
 * the invoice exists and only the answer was lost.
 */
export function writeProvablyDidNotHappen(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status = /Zoho Books (\d{3})/.exec(message)?.[1];
  if (!status) return false;
  const code = Number(status);
  if (code === 408 || code === 429) return false;
  return code >= 400 && code < 500;
}

const str = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const num = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return null;
};

/**
 * What the member reads before saying yes.
 *
 * Plain lines, real amounts, no field names. Someone who does not know Zoho has
 * to be able to spot the wrong customer or the wrong number in it, because
 * spotting that is the only job this text has.
 */
export function renderStagedInvoice(input: {
  payload: Record<string, unknown>;
  customerName?: string | undefined;
  findings: readonly InvoiceFinding[];
  attachFileName?: string | undefined;
}): string {
  const { payload } = input;
  const currency = str(payload['currency_code']) || 'INR';
  const money = (value: number) => formatAmount(value, currency);

  const lines: string[] = [];
  const customer = input.customerName || str(payload['customer_name']) || str(payload['customer_id']);
  lines.push(`Customer: ${customer || 'not set'}`);

  const invoiceNumber = str(payload['invoice_number']);
  lines.push(`Invoice number: ${invoiceNumber || 'assigned by Zoho'}`);

  const date = str(payload['date']);
  const dueDate = str(payload['due_date']);
  if (date) lines.push(`Date: ${date}`);
  if (dueDate) lines.push(`Due: ${dueDate}`);

  const items = invoiceLineItems(payload);
  if (items.length > 0) {
    lines.push('Lines:');
    for (const item of items) {
      const name = str(item['name']) || str(item['description']) || 'unnamed line';
      const quantity = num(item['quantity']);
      const rate = num(item['rate']);
      const tax = str(item['tax_name']);
      const amount = rate !== null && quantity !== null ? money(rate * quantity) : null;
      const parts = [
        `  • ${name}`,
        quantity !== null && rate !== null ? `${quantity} × ${money(rate)}` : null,
        amount ? `= ${amount}` : null,
        tax ? `(${tax})` : null,
      ].filter(Boolean);
      lines.push(parts.join(' '));
    }
  }

  const derived = derivedLineTotal(items);
  if (derived !== null) {
    lines.push(`Before tax: ${money(derived)}`);
    lines.push('Tax and total are calculated by Zoho when the invoice is created.');
  }

  const placeOfSupply = str(payload['place_of_supply']);
  if (placeOfSupply) lines.push(`Place of supply: ${placeOfSupply}`);

  if (input.attachFileName) lines.push(`Attachment: ${input.attachFileName}`);

  const notes = str(payload['notes']);
  if (notes) lines.push(`Notes: ${notes.slice(0, 300)}`);

  if (input.findings.length > 0) {
    lines.push('');
    lines.push('Checks:');
    for (const finding of input.findings) {
      lines.push(`  ${finding.severity === 'blocking' ? '✗' : '!'} ${finding.message}`);
    }
  }

  return lines.join('\n');
}

export interface StoredInvoiceDrift {
  readonly field: string;
  readonly staged: string;
  readonly stored: string;
}

/**
 * What Zoho did to the payload after it was approved.
 *
 * Staging cannot see this. Zoho computes totals, applies its own rounding,
 * assigns numbers, and drops fields it does not recognise without saying so —
 * so a payload that was correct going in can still be stored as something the
 * member did not agree to. This is a comparison, not another opinion: it
 * reports differences and lets the member decide.
 *
 * Only fields the member was actually shown are compared. Reporting drift in a
 * field nobody saw would be noise.
 */
export function compareStagedToStored(
  staged: Record<string, unknown>,
  stored: Record<string, unknown>,
): StoredInvoiceDrift[] {
  const drift: StoredInvoiceDrift[] = [];

  const compare = (field: string, left: string, right: string) => {
    if (left && left !== right) drift.push({ field, staged: left, stored: right });
  };

  compare('customer', str(staged['customer_id']), str(stored['customer_id']));
  compare('invoice number', str(staged['invoice_number']), str(stored['invoice_number']));
  compare('date', str(staged['date']), str(stored['date']));
  compare('due date', str(staged['due_date']), str(stored['due_date']));
  compare('currency', str(staged['currency_code']), str(stored['currency_code']));
  compare('place of supply', str(staged['place_of_supply']), str(stored['place_of_supply']));

  const stagedItems = invoiceLineItems(staged);
  const storedItems = invoiceLineItems(stored);
  if (stagedItems.length !== storedItems.length) {
    drift.push({
      field: 'line count',
      staged: String(stagedItems.length),
      stored: String(storedItems.length),
    });
  }

  // The number the member was shown, against what Zoho actually charged for.
  const stagedTotal = derivedLineTotal(stagedItems);
  const storedSubTotal = num(stored['sub_total']);
  if (stagedTotal !== null && storedSubTotal !== null && Math.abs(stagedTotal - storedSubTotal) > 0.02) {
    drift.push({
      field: 'amount before tax',
      staged: stagedTotal.toFixed(2),
      stored: storedSubTotal.toFixed(2),
    });
  }

  return drift;
}

/**
 * What moved between two drafts.
 *
 * Given to the reviewer on a retry so it can see the correction as a fact. It
 * is deliberately not given the previous verdict: a reviewer told what the last
 * one objected to tends to agree with it, and a re-raised objection is the only
 * honest signal that a fix did not work.
 */
export function describePayloadChange(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const changes: string[] = [];
  const fields = ['customer_id', 'invoice_number', 'date', 'due_date', 'currency_code', 'place_of_supply', 'notes'];
  for (const field of fields) {
    const left = str(before[field]);
    const right = str(after[field]);
    if (left !== right) changes.push(`${field}: ${left || '(unset)'} → ${right || '(unset)'}`);
  }

  const beforeItems = invoiceLineItems(before);
  const afterItems = invoiceLineItems(after);
  if (beforeItems.length !== afterItems.length) {
    changes.push(`line count: ${beforeItems.length} → ${afterItems.length}`);
  }
  const beforeTotal = derivedLineTotal(beforeItems);
  const afterTotal = derivedLineTotal(afterItems);
  if (beforeTotal !== null && afterTotal !== null && Math.abs(beforeTotal - afterTotal) > 0.02) {
    changes.push(`amount before tax: ${beforeTotal.toFixed(2)} → ${afterTotal.toFixed(2)}`);
  }
  return changes;
}
