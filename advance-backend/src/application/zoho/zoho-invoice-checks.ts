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
 * These run once, over a staged payload, before anything is created. Zoho has
 * computed nothing at that point — the totals it would supply are absent — so
 * the arithmetic is derived from the lines instead. What Zoho then did to the
 * payload on the way in is a separate question, answered by diffing the stored
 * record against what was approved rather than by re-running these.
 */

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
   * The duplicate search was attempted and could not complete.
   *
   * Distinct from an empty result, which is an answer. An empty list from a
   * lookup that never ran would report "that number is free" — on the one path
   * where the member's own number switches Zoho's numbering off, and a repeat
   * therefore reaches the books.
   */
  readonly duplicateCheckUnavailable?: boolean | undefined;
  /**
   * The selling organisation's GST state code. Absent means the IGST-versus-
   * CGST rule cannot be decided, and it is reported as unchecked rather than
   * guessed — the internal-consistency checks still run.
   */
  readonly homeGstStateCode?: string | undefined;
  /**
   * Which direction each configured tax is for, keyed by `tax_id`, from Zoho's
   * own `tax_specification`.
   *
   * A staged payload names no taxes: it carries `tax_id`, because that is what
   * Zoho accepts and what the skill tells the model to send. Names only appear
   * once Zoho has expanded them onto a created invoice — by which point the
   * invoice exists and the check has nothing left to prevent. Without this map
   * the GST direction rules simply never fire on a draft.
   *
   * Zoho's own classification is used rather than the tax's name because the
   * intra-state tax is a group called "GST18" — the words CGST and SGST appear
   * nowhere in it, and only surface as components after creation.
   */
  readonly taxDirectionById?: Readonly<Record<string, GstDirection>> | undefined;
}

/** Inter-state is IGST; intra-state is CGST plus SGST (or UTGST). */
export type GstDirection = 'inter' | 'intra';

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

/**
 * Every tax on the invoice, however it was written down.
 *
 * A draft names nothing and carries `tax_id`; a created invoice carries names
 * and no longer needs the map. Both are collected, so one function serves the
 * check before creation and the drift check after it.
 */
const taxRefs = (invoice: Record<string, unknown>): { names: string[]; ids: string[] } => {
  const names: string[] = [];
  const ids:   string[] = [];
  const take = (tax: Record<string, unknown>) => {
    names.push(str(tax['tax_name']));
    ids.push(str(tax['tax_id']));
  };

  const taxes = invoice['taxes'];
  if (Array.isArray(taxes)) for (const tax of taxes.filter(isRecord)) take(tax);

  for (const line of lines(invoice)) {
    take(line);
    const lineTaxes = line['line_item_taxes'];
    if (Array.isArray(lineTaxes)) for (const tax of lineTaxes.filter(isRecord)) take(tax);
  }

  return { names: names.filter(n => n.length > 0), ids: ids.filter(id => id.length > 0) };
};

// Leading boundary only. Zoho names its taxes "IGST18", "CGST9", "SGST 9%" —
// a trailing \b never matches, because a digit is a word character too, and the
// whole GST check silently found nothing.
const hasIgst = (names: readonly string[]): boolean =>
  names.some(name => /\bigst/i.test(name));

const hasIntraStateGst = (names: readonly string[]): boolean =>
  names.some(name => /\b(cgst|sgst|utgst)/i.test(name));

const directionsOf = (
  refs: { names: string[]; ids: string[] },
  byId: Readonly<Record<string, GstDirection>> | undefined,
): { igst: boolean; intraState: boolean } => {
  const resolved = byId ? refs.ids.map(id => byId[id]).filter(Boolean) : [];
  return {
    igst:       hasIgst(refs.names)          || resolved.includes('inter'),
    intraState: hasIntraStateGst(refs.names) || resolved.includes('intra'),
  };
};

/** Zoho reports place of supply as a state code such as "RJ" or "08". */
const stateCodeOf = (value: unknown): string => str(value).trim().toUpperCase();

/**
 * Both sides must be written the same way before a difference between them
 * means anything.
 *
 * India's states have two spellings — the GSTIN's numeric prefix ("08") and
 * Zoho's letter code ("RJ") — and they never match each other. Comparing across
 * them does not fail safely: every intra-state sale looks inter-state, and the
 * finding is *blocking*, telling the model to switch a correct CGST/SGST
 * invoice to IGST. A mismatched pair is therefore not an answer, it is the
 * absence of one.
 */
const comparableStates = (a: string, b: string): boolean =>
  (/^[A-Z]{2}$/.test(a) && /^[A-Z]{2}$/.test(b))
  || (/^\d{1,2}$/.test(a) && /^\d{1,2}$/.test(b));

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
  const refs = taxRefs(invoice);
  const { igst, intraState } = directionsOf(refs, input.taxDirectionById);
  const names = refs.names;

  // True regardless of anyone's location: a supply is either inter-state or
  // intra-state, never both.
  if (igst && intraState) {
    add(
      'mixed_gst',
      'blocking',
      names.length > 0
        ? `The invoice carries both IGST and CGST/SGST (${[...new Set(names)].join(', ')}). A supply is one or the other.`
        : 'The invoice carries both an inter-state and an intra-state tax. A supply is one or the other.',
    );
  }

  const placeOfSupply = stateCodeOf(invoice['place_of_supply']);
  const homeRaw = stateCodeOf(input.homeGstStateCode);
  const home = comparableStates(homeRaw, placeOfSupply) ? homeRaw : '';
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
  } else if (input.duplicateCheckUnavailable && invoiceNumber) {
    add(
      'duplicate_check_unavailable',
      'warning',
      `Whether invoice number ${invoiceNumber} is already in use could not be checked: the lookup in Zoho failed. `
      + 'Supplying a number turns Zoho\'s own numbering off, so nothing else would catch a repeat.',
    );
  }

  return findings;
}

export const hasBlockingFinding = (findings: readonly InvoiceFinding[]): boolean =>
  findings.some(finding => finding.severity === 'blocking');
