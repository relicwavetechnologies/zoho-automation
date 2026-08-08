/**
 * Making an invoice payload say what Zoho means by it.
 *
 * `payment_terms` is the case this exists for. To a person — and to a model
 * reading a PDF that says "Net 15" — the payment term IS "Net 15". To Zoho it
 * is the integer 15, a count of days, and the words live in a different field
 * called `payment_terms_label`. Send the words and Zoho answers
 * `{"code":2,"message":"Invalid value passed for Payment Terms"}` and creates
 * nothing.
 *
 * So this translates rather than validates. "Net 15" is not a mistake the
 * member made; it is the same fact in the vocabulary they use. Pulling the
 * number out of it is mechanical, and the original words are kept as the label
 * instead of being thrown away, so the invoice still reads the way the document
 * did.
 *
 * What it will not do is guess. A term with no number in it and no known
 * meaning is refused by name, before anything is staged, rather than dropped
 * silently — quietly discarding a payment term would change when the invoice
 * falls due while reporting success.
 */

export type InvoiceFieldsResult =
  | { readonly ok: true; readonly fields: Record<string, unknown>; readonly notes: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Terms Zoho itself ships that carry no digit. "Due on receipt" is zero days in
 * Zoho's own numbering, not an interpretation of ours.
 */
const namedTerms: Record<string, number> = {
  'due on receipt': 0,
  'due upon receipt': 0,
  'on receipt': 0,
  'immediate': 0,
  'immediately': 0,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const REFUSAL =
  'Zoho Books records payment terms as a whole number of days, so this invoice was not staged. '
  + 'Give payment_terms as a number — 15 for "Net 15", 0 for due on receipt — or set due_date '
  + 'instead and leave payment_terms out.';

interface ParsedTerms {
  readonly days: number;
  /** The member's own wording, when it was not already a bare number. */
  readonly label?: string;
}

function parsePaymentTerms(value: unknown): ParsedTerms | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? { days: value } : null;
  }
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (!raw) return null;

  // Already a number, just wearing quotes.
  if (/^\d+$/.test(raw)) return { days: Number(raw) };

  const named = namedTerms[raw.toLowerCase()];
  if (named !== undefined) return { days: named, label: raw };

  // Exactly one run of digits: "Net 15", "15 days", "net-15", "NET15".
  // Two numbers means something we do not understand well enough to act on —
  // "2/10 net 30" is a discount schedule, not a due date.
  const digits = raw.match(/\d+/g);
  if (digits?.length === 1) {
    const days = Number(digits[0]);
    if (Number.isSafeInteger(days) && days >= 0) return { days, label: raw };
  }

  return null;
}

/**
 * Normalise an invoice payload on its way to Zoho.
 *
 * Returns a new object; the caller's payload is left alone so that what was
 * staged, reviewed, and shown to the member stays the thing that was checked.
 */
export function normalizeInvoiceFields(fields: Record<string, unknown>): InvoiceFieldsResult {
  const out: Record<string, unknown> = { ...fields };
  const notes: string[] = [];

  if (out['payment_terms'] !== undefined && out['payment_terms'] !== null) {
    const parsed = parsePaymentTerms(out['payment_terms']);
    if (!parsed) return { ok: false, message: REFUSAL };

    if (out['payment_terms'] !== parsed.days) {
      notes.push(`payment_terms ${JSON.stringify(out['payment_terms'])} read as ${parsed.days} days`);
    }
    out['payment_terms'] = parsed.days;

    // Keep the member's wording where Zoho keeps wording — but never overwrite
    // a label they set deliberately.
    if (parsed.label && out['payment_terms_label'] === undefined) {
      out['payment_terms_label'] = parsed.label;
    }
  }

  const lineItems = out['line_items'];
  if (Array.isArray(lineItems)) {
    out['line_items'] = lineItems.map(item => (isRecord(item) ? { ...item } : item));
  }

  return { ok: true, fields: out, notes };
}
