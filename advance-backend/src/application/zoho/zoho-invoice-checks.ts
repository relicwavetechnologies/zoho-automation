/**
 * What can be decided about an invoice without asking anyone.
 *
 * These run before the reviewer and the reviewer cannot overrule them. The
 * split matters: whether a line total adds up, whether a due date precedes its
 * invoice date, whether IGST and CGST are both present — these have answers,
 * and a model that says "looks correct" about a wrong GST split has not
 * verified it, it has laundered it. Judgement is reserved for the one question
 * rules cannot answer: is this the invoice the member asked for.
 *
 * Every check names the field it read. A finding a member cannot trace back to
 * a number on their invoice is a finding they cannot act on.
 *
 * The same checks run twice, over two different things. Before creation they
 * read a staged payload, where Zoho has computed nothing yet — so the totals it
 * would supply are absent and the arithmetic is derived from the lines instead.
 * After creation they read the stored record. Sharing the rules is the point:
 * a payload that passes and a record that then fails means Zoho did something
 * to it, which is exactly what the post-create diff is looking for.
 */

import { createHash } from 'node:crypto';

export type InvoiceFindingSeverity = 'blocking' | 'warning';

export interface InvoiceFinding {
  readonly code: string;
  readonly severity: InvoiceFindingSeverity;
  readonly message: string;
}

export interface InvoiceCheckInput {
  /**
   * A staged payload before creation, or the record re-fetched from Zoho after
   * it — never the write response, which is the one thing that cannot disagree
   * with itself.
   */
  readonly invoice: Record<string, unknown>;
  /** Other invoices carrying the same number, if a duplicate search ran. */
  readonly sameNumberInvoices?: readonly Record<string, unknown>[];
  /**
   * The selling organisation's GST state code. Absent means the IGST-versus-
   * CGST rule cannot be decided, and it is reported as unchecked rather than
   * guessed — the internal-consistency checks still run.
   */
  readonly homeGstStateCode?: string | undefined;
  /** True when the member sent a file that was meant to end up on this invoice. */
  readonly documentExpected?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const num = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const str = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const lines = (invoice: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(invoice['line_items']) ? invoice['line_items'].filter(isRecord) : [];

/** Money compared at paise, not at floating point. */
const differsBeyondRounding = (left: number, right: number): boolean =>
  Math.abs(left - right) > 0.02;

/** What the lines come to, or null when any of them cannot be read as money. */
export function derivedLineTotal(items: readonly Record<string, unknown>[]): number | null {
  if (items.length === 0) return null;
  let computed = 0;
  for (const item of items) {
    const itemTotal = num(item['item_total']);
    if (itemTotal !== null) { computed += itemTotal; continue; }
    const rate = num(item['rate']);
    const quantity = num(item['quantity']);
    if (rate === null || quantity === null) return null;
    computed += rate * quantity;
  }
  return computed;
}

export const invoiceLineItems = lines;

const taxNames = (invoice: Record<string, unknown>): string[] => {
  const names: string[] = [];
  const taxes = invoice['taxes'];
  if (Array.isArray(taxes)) {
    for (const tax of taxes.filter(isRecord)) names.push(str(tax['tax_name']));
  }
  for (const line of lines(invoice)) {
    names.push(str(line['tax_name']));
    const lineTaxes = line['line_item_taxes'];
    if (Array.isArray(lineTaxes)) {
      for (const tax of lineTaxes.filter(isRecord)) names.push(str(tax['tax_name']));
    }
  }
  return names.filter(name => name.length > 0);
};

// Leading boundary only. Zoho names its taxes "IGST18", "CGST9", "SGST 9%" —
// a trailing \b never matches, because a digit is a word character too, and the
// whole GST check silently found nothing.
const hasIgst = (names: readonly string[]): boolean =>
  names.some(name => /\bigst/i.test(name));

const hasIntraStateGst = (names: readonly string[]): boolean =>
  names.some(name => /\b(cgst|sgst|utgst)/i.test(name));

/** Zoho reports place of supply as a state code such as "RJ" or "08". */
const stateCodeOf = (value: unknown): string => str(value).toUpperCase();

export function checkInvoice(input: InvoiceCheckInput): InvoiceFinding[] {
  const { invoice } = input;
  const findings: InvoiceFinding[] = [];
  const add = (code: string, severity: InvoiceFindingSeverity, message: string) =>
    findings.push({ code, severity, message });

  // ── Structure ─────────────────────────────────────────────────────────────
  if (!str(invoice['customer_id'])) {
    add('missing_customer', 'blocking', 'The invoice has no customer_id, so it is not addressed to anyone.');
  }

  const items = lines(invoice);
  if (items.length === 0) {
    add('no_line_items', 'blocking', 'The invoice has no line items, so it bills for nothing.');
  }

  // ── Arithmetic ────────────────────────────────────────────────────────────
  // A staged payload has no sub_total: Zoho computes it. There is nothing to
  // disagree with yet, so the comparison is simply skipped rather than being
  // run against a zero and reported as a mismatch.
  const subTotal = num(invoice['sub_total']);
  const derived = derivedLineTotal(items);
  if (subTotal !== null && derived !== null && differsBeyondRounding(derived, subTotal)) {
    add(
      'line_total_mismatch',
      'blocking',
      `The line items add up to ${derived.toFixed(2)} but sub_total says ${subTotal.toFixed(2)}.`,
    );
  }

  const total = num(invoice['total']);
  if (total !== null && total <= 0) {
    add('non_positive_total', 'blocking', `The invoice total is ${total.toFixed(2)}, so it asks the customer for nothing.`);
  }
  if (total === null && derived !== null && derived <= 0 && items.length > 0) {
    add('non_positive_total', 'blocking', `The line items come to ${derived.toFixed(2)}, so this would ask the customer for nothing.`);
  }

  for (const item of items) {
    const quantity = num(item['quantity']);
    const rate = num(item['rate']);
    const name = str(item['name']) || str(item['description']) || 'a line item';
    if (quantity !== null && quantity <= 0) {
      add('non_positive_quantity', 'blocking', `Line "${name}" has quantity ${quantity}.`);
    }
    if (rate !== null && rate < 0) {
      add('negative_rate', 'blocking', `Line "${name}" has a negative rate of ${rate}.`);
    }
  }

  // ── Dates ─────────────────────────────────────────────────────────────────
  const date = str(invoice['date']);
  const dueDate = str(invoice['due_date']);
  if (date && dueDate && dueDate < date) {
    add('due_before_issue', 'blocking', `The due date ${dueDate} is before the invoice date ${date}.`);
  }

  // ── GST ───────────────────────────────────────────────────────────────────
  const names = taxNames(invoice);
  const igst = hasIgst(names);
  const intraState = hasIntraStateGst(names);

  // True regardless of anyone's location: a supply is either inter-state or
  // intra-state, never both.
  if (igst && intraState) {
    add(
      'mixed_gst',
      'blocking',
      `The invoice carries both IGST and CGST/SGST (${[...new Set(names)].join(', ')}). A supply is one or the other.`,
    );
  }

  const placeOfSupply = stateCodeOf(invoice['place_of_supply']);
  const home = stateCodeOf(input.homeGstStateCode);
  if (home && placeOfSupply && (igst || intraState)) {
    const interState = placeOfSupply !== home;
    if (interState && intraState) {
      add('gst_should_be_igst', 'blocking', `Place of supply ${placeOfSupply} differs from the selling state ${home}, so this should be IGST, not CGST/SGST.`);
    }
    if (!interState && igst) {
      add('gst_should_be_split', 'blocking', `Place of supply ${placeOfSupply} matches the selling state ${home}, so this should be CGST plus SGST, not IGST.`);
    }
  } else if (!home && (igst || intraState)) {
    add(
      'gst_direction_unchecked',
      'warning',
      'Whether GST should be IGST or CGST/SGST was not checked: the selling organisation\'s GST state is not configured.',
    );
  }

  // ── Duplicates ────────────────────────────────────────────────────────────
  const invoiceNumber = str(invoice['invoice_number']);
  const invoiceId = str(invoice['invoice_id']);
  const duplicates = (input.sameNumberInvoices ?? []).filter(other =>
    str(other['invoice_id']) !== invoiceId
    && str(other['invoice_number']).toLowerCase() === invoiceNumber.toLowerCase()
    && invoiceNumber.length > 0);
  if (duplicates.length > 0) {
    add(
      'duplicate_number',
      'blocking',
      `Invoice number ${invoiceNumber} is already used by ${duplicates.map(d => str(d['invoice_id'])).join(', ')}.`,
    );
  }

  // ── Attachment ────────────────────────────────────────────────────────────
  if (input.documentExpected) {
    const documents = Array.isArray(invoice['documents']) ? invoice['documents'] : [];
    if (documents.length === 0) {
      add('missing_document', 'blocking', 'A file was meant to be attached to this invoice, and Zoho lists none.');
    }
  }

  return findings;
}

export const hasBlockingFinding = (findings: readonly InvoiceFinding[]): boolean =>
  findings.some(finding => finding.severity === 'blocking');

/**
 * Identity of the *content* of an invoice.
 *
 * A review is a statement about a specific set of numbers. If any of them move
 * afterwards the review no longer describes what is stored, so issuing has to
 * demand a fresh one. Only the fields a review could reasonably turn on are
 * included — `last_modified_time` would invalidate on every unrelated touch.
 */
export function invoiceRevisionHash(invoice: Record<string, unknown>): string {
  const canonical = {
    customer_id: str(invoice['customer_id']),
    invoice_number: str(invoice['invoice_number']),
    date: str(invoice['date']),
    due_date: str(invoice['due_date']),
    currency_code: str(invoice['currency_code']),
    place_of_supply: str(invoice['place_of_supply']),
    total: num(invoice['total']),
    sub_total: num(invoice['sub_total']),
    tax_total: num(invoice['tax_total']),
    documents: (Array.isArray(invoice['documents']) ? invoice['documents'] : [])
      .filter(isRecord)
      .map(document => str(document['file_name']))
      .sort(),
    line_items: lines(invoice).map(item => ({
      item_id: str(item['item_id']),
      name: str(item['name']),
      description: str(item['description']),
      quantity: num(item['quantity']),
      rate: num(item['rate']),
      tax_id: str(item['tax_id']),
    })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
