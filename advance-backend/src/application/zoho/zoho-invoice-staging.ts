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
  classifyZohoBooksWriteFailure,
  type ZohoBooksWriteFailure,
} from './zoho-books-write';
import {
  derivedLineTotal,
  invoiceLineItems,
  type InvoiceFinding,
} from './zoho-invoice-checks';
import type { InvoiceReviewVerdict } from './zoho-invoice-reviewer';
import {
  formatInvoiceAddress,
  type InvoiceSourcePolicySnapshot,
} from './zoho-invoice-source-policy';

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
  /** Backend-decided source facts kept out of the exact Zoho request body. */
  readonly sourcePolicy?: InvoiceSourcePolicySnapshot | undefined;
  readonly attempt: number;
  /** The draft this one corrects, when it is a retry. */
  readonly supersedesId?: string | undefined;
  readonly createdInvoiceId?: string | undefined;
  /** When the create was dispatched, if it ever was. */
  readonly claimedAt?: Date | undefined;
  /** When the draft was staged. Anchors the search for what it may have created. */
  readonly createdAt?: Date | undefined;
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

/**
 * Held when an unresolved create was later searched for and not found.
 *
 * Distinct from {@link INVOICE_CLAIM_UNRESOLVED} so the draft stops being
 * treated as an open question. It is not a release: the draft is still spent,
 * and the record of what happened to it survives.
 */
export const INVOICE_CLAIM_ABSENT = 'absent:';

/**
 * How long a create may plausibly still be in flight.
 *
 * A claim older than this was not left by a request that is still running; it
 * was left by a process that died holding it — a deploy, an OOM, a killed
 * container. Which is one of the ways the answer gets lost in the first place,
 * so a stale claim has to be read back exactly like an unresolved one rather
 * than sitting invisible while a retry bills the customer again.
 */
export const INVOICE_WRITE_CEILING_MS = 10 * 60_000;

export interface StagedInvoiceStore {
  put(staged: StagedInvoice): Promise<void>;
  get(input: { stagingId: string; companyId: string; userId: string }): Promise<StagedInvoice | null>;
  claim(input: { stagingId: string; companyId: string; marker: string }): Promise<{ claimed: boolean; heldBy?: string }>;
  settle(input: { stagingId: string; companyId: string; invoiceId: string }): Promise<void>;
  release(input: { stagingId: string; companyId: string; marker: string }): Promise<void>;
  /** Replaces an in-flight claim with a state no retry may clear. */
  markUnresolved(input: { stagingId: string; companyId: string; marker: string; unresolved: string }): Promise<void>;
  /**
   * Records that a draft's create was searched for and not found.
   *
   * Conditional on the marker it expects to replace, like {@link release} and
   * {@link markUnresolved}. An unconditional write here would let one request
   * overwrite a claim another is still holding, and the in-flight request's own
   * outcome would then be silently discarded.
   */
  markAbsent(input: { stagingId: string; companyId: string; marker: string; absent: string }): Promise<void>;
  /**
   * Drafts whose create never reported back, for this connection.
   *
   * The claim protects one draft. This is what protects the *work*: a member
   * told "that may or may not have gone through" will very reasonably ask for
   * it again, and the second attempt arrives as a brand-new draft carrying no
   * claim at all. Finding the earlier unresolved draft is what makes the
   * duplicate answerable before it is billed.
   *
   * Not scoped to the member. Someone whose create was lost tells a colleague,
   * the colleague asks Divo to raise it, and the customer is billed twice —
   * the books are shared even when the drafts are not. Nothing from the earlier
   * draft is revealed beyond the fact that an attempt exists.
   *
   * In-flight claims are returned too, however fresh. A claim younger than
   * {@link INVOICE_WRITE_CEILING_MS} means a request is very likely still
   * running, which is a reason to refuse a twin outright rather than a reason
   * to ignore it.
   *
   * So are drafts already searched for and not found, while they are still
   * live. Zoho's indexes lag, so one empty search is evidence rather than
   * proof, and re-checking costs a single list call.
   */
  findUnresolved(input: {
    companyId: string;
    connectionId: string;
  }): Promise<readonly StagedInvoice[]>;
}

/**
 * What a failed write proves about Zoho's books.
 *
 * Deliberately three answers rather than a boolean. "Did not happen" and "we
 * cannot tell" call for opposite handling — one hands the draft back, the other
 * must never — and collapsing the reasons into a single flag is what previously
 * let a revoked refresh token be reported to a member as "your invoice may have
 * been created, go and look for it". Each case carries the sentence that
 * explains it, so the member is told what actually went wrong rather than a
 * catch-all.
 */
export type WriteFailure = ZohoBooksWriteFailure;

export function classifyWriteFailure(error: unknown): WriteFailure {
  return classifyZohoBooksWriteFailure(error, { receivedObject: 'the invoice' });
}

/**
 * Where to look in Zoho for an invoice that may have been created from a draft.
 *
 * Narrow enough to be cheap, wide enough to survive a timezone: Zoho dates an
 * invoice in the organisation's zone, which can be a calendar day away from
 * this process's. The window is a day either side of the draft's own date, or
 * of today when the draft let Zoho choose.
 *
 * `customer_id` and the date bounds are both filters Zoho honours. That matters
 * more than it sounds: Zoho answers a filter it does not recognise by returning
 * the unfiltered list, so a lookup built on an unsupported field would quietly
 * search everything and match nothing.
 */
export function stagedInvoiceSearchWindow(
  staged: Pick<StagedInvoice, 'payload' | 'createdAt'>,
  now: Date,
): { customerId: string; dateStart: string; dateEnd: string } | null {
  const customerId = str(staged.payload['customer_id']);
  if (!customerId) return null;

  const asDay = (date: Date) => date.toISOString().slice(0, 10);
  // When the draft let Zoho pick the date, Zoho picked it on the day the write
  // went out — which may be days before this check runs. Anchoring on `now`
  // would search the wrong days and report the invoice missing.
  const day = str(staged.payload['date']) || asDay(staged.createdAt ?? now);
  const centre = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(centre.getTime())) return null;

  const shift = (from: Date, days: number) =>
    asDay(new Date(from.getTime() + days * 86_400_000));

  // Open at the far end: an old draft still has to be searched up to today,
  // because that is where a late or re-dated invoice would sit.
  const end = shift(centre, 1) > shift(now, 1) ? shift(centre, 1) : shift(now, 1);
  return { customerId, dateStart: shift(centre, -1), dateEnd: end };
}

/**
 * Three answers, because "cannot tell" is not "no".
 *
 * This decides whether an invoice already in Zoho is the one a draft would have
 * created — and its result authorises, or refuses, a second real invoice. A
 * matcher that answered a question it could not decide with `false` would hand
 * the caller "proved absent" and green-light the duplicate.
 *
 * That is not hypothetical. Zoho's invoice *list* rows carry `total` but no
 * `sub_total` and no `line_items`, so a draft that let Zoho assign the number —
 * the recommended path — is undecidable from a list row alone and needs the
 * record fetched.
 */
export type StagedInvoiceMatch = 'match' | 'no' | 'undecidable';

export function matchStagedInvoice(
  staged: Pick<StagedInvoice, 'payload'>,
  candidate: Record<string, unknown>,
): StagedInvoiceMatch {
  const stagedCustomer = str(staged.payload['customer_id']);
  if (!stagedCustomer) return 'undecidable';
  if (stagedCustomer !== str(candidate['customer_id'])) return 'no';

  // A number decides outright — but only when both sides carry one. Comparing a
  // number against a blank is how a numbered first attempt and an unnumbered
  // re-stage of the same invoice looked like different invoices.
  const stagedNumber = str(staged.payload['invoice_number']);
  const candidateNumber = str(candidate['invoice_number']);
  if (stagedNumber && candidateNumber) {
    return stagedNumber.toLowerCase() === candidateNumber.toLowerCase() ? 'match' : 'no';
  }

  // Otherwise identity rests on the amount. Pre-tax, because that is what
  // staging can compute; Zoho's `total` includes tax the draft never carried.
  const stagedItems = invoiceLineItems(staged.payload);
  const stagedTotal = listPriceTotal(stagedItems);
  if (stagedItems.length === 0 || stagedTotal === null) return 'undecidable';

  const candidateItems = invoiceLineItems(candidate);
  if (candidateItems.length > 0 && candidateItems.length !== stagedItems.length) return 'no';

  // Rate times quantity on both sides, deliberately ignoring `item_total` and
  // `sub_total`. Zoho applies customer price lists and line discounts on the
  // way in — which is why a drift check exists at all — so the amount it
  // stored can differ from the amount that was sent while being the very same
  // invoice.
  const candidateTotal = candidateItems.length > 0
    ? listPriceTotal(candidateItems)
    : num(candidate['sub_total']);
  if (candidateTotal === null) return 'undecidable';
  if (Math.abs(stagedTotal - candidateTotal) <= 0.02) return 'match';

  // Same customer, same line count, different money. That is either a repriced
  // version of this invoice or a different one, and this cannot tell which.
  // Answering 'no' would report it absent and authorise a second real invoice.
  return candidateItems.length > 0 ? 'undecidable' : 'no';
}

/**
 * What the lines come to before Zoho touches them.
 *
 * Rate times quantity only. {@link derivedLineTotal} prefers `item_total`,
 * which is what Zoho *decided* a line costs after discounts — the right number
 * for checking a draft's own arithmetic, the wrong one for asking whether two
 * records describe the same invoice.
 */
function listPriceTotal(items: readonly Record<string, unknown>[]): number | null {
  if (items.length === 0) return null;
  let total = 0;
  for (const item of items) {
    const rate = num(item['rate']);
    const quantity = num(item['quantity']);
    if (rate === null || quantity === null) return null;
    total += rate * quantity;
  }
  return total;
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
  sourcePolicy?: InvoiceSourcePolicySnapshot | undefined;
  findings: readonly InvoiceFinding[];
  attachFileName?: string | undefined;
}): string {
  const { payload } = input;
  const currency = str(payload['currency_code']) || 'INR';
  const money = (value: number) => formatAmount(value, currency);

  const lines: string[] = [];
  const customer = input.customerName || str(payload['customer_name']) || str(payload['customer_id']);
  lines.push(`Customer: ${customer || 'not set'}`);
  if (input.sourcePolicy?.billingAddress) {
    lines.push(`Billing address: ${formatInvoiceAddress(input.sourcePolicy.billingAddress)}`);
  }

  const invoiceNumber = str(payload['invoice_number']);
  lines.push(`Invoice number: ${invoiceNumber || 'assigned by Zoho'}`);

  const date = str(payload['date']);
  const dueDate = str(payload['due_date']);
  if (date) lines.push(`Date: ${date}`);
  if (dueDate) lines.push(`Due: ${dueDate}`);

  // When terms set the due date rather than a date doing it, the summary said
  // nothing at all about when the invoice falls due — the one number the member
  // is most likely to want to correct. The label is Zoho's own wording where it
  // has one.
  if (!dueDate) {
    const terms = num(payload['payment_terms']);
    if (terms !== null) {
      const spelled = terms === 0 ? 'due on receipt' : `${terms} days`;
      const label = str(payload['payment_terms_label']);
      // Only when it adds something. "due on receipt (due on receipt)" reads
      // like a mistake, because it is one.
      const suffix = label && label.toLowerCase() !== spelled.toLowerCase() ? ` (${label})` : '';
      lines.push(`Payment terms: ${spelled}${suffix}`);
    }
  }

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
  sourcePolicy?: InvoiceSourcePolicySnapshot,
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

  if (sourcePolicy?.billingAddress) {
    const expected = formatInvoiceAddress(sourcePolicy.billingAddress);
    const rawStoredAddress = stored['billing_address'];
    const address = rawStoredAddress && typeof rawStoredAddress === 'object' && !Array.isArray(rawStoredAddress)
      ? rawStoredAddress as Record<string, unknown>
      : {};
    const actual = [
      str(address['address'] ?? address['street']),
      str(address['street2']),
      str(address['city']),
      str(address['state']),
      str(address['zip']),
      str(address['country']),
    ].filter(Boolean).join(', ');
    const comparable = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (comparable(expected) !== comparable(actual)) {
      drift.push({ field: 'billing address', staged: expected, stored: actual || '(missing)' });
    }
  }

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
