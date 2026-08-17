/**
 * Deterministic rules for turning a source document into an invoice payload.
 *
 * The model identifies the customer and line items. This module owns the two
 * facts that must not be left to provider defaults or interpretation:
 *
 * - every new invoice is dated on the day it is created; and
 * - a document carrying "Bill To" selects that exact saved customer address.
 *
 * The returned payload remains the exact body sent to Zoho. Evidence used to
 * render and verify the decision is kept separately in `sourcePolicy`.
 */

export interface InvoiceAddressSnapshot {
  readonly addressId: string;
  readonly address: string;
  readonly street2?: string | undefined;
  readonly city?: string | undefined;
  readonly state?: string | undefined;
  readonly zip?: string | undefined;
  readonly country?: string | undefined;
}

export interface InvoiceSourcePolicySnapshot {
  readonly documentKind?: 'quote' | 'estimate' | undefined;
  readonly billingAddress?: InvoiceAddressSnapshot | undefined;
  readonly originalDocumentDate?: string | undefined;
  readonly invoiceDate?: string | undefined;
}

export type InvoiceSourcePolicyResult =
  | {
      readonly ok: true;
      readonly payload: Record<string, unknown>;
      readonly notes: readonly string[];
      readonly sourcePolicy: InvoiceSourcePolicySnapshot;
    }
  | { readonly ok: false; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const normalize = (value: string): string =>
  value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

const dateParts = (value: string): [number, number, number] | null => {
  if (!isoDate.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  return year && month && day ? [year, month, day] : null;
};

const epochDay = (value: string): number | null => {
  const parts = dateParts(value);
  return parts ? Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86_400_000) : null;
};

const addDays = (value: string, days: number): string => {
  const start = epochDay(value);
  if (start === null) return value;
  return new Date((start + days) * 86_400_000).toISOString().slice(0, 10);
};

export function dateInTimeZone(now: Date, timeZone?: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map(part => [part.type, part.value]),
  );
  return `${parts['year']}-${parts['month']}-${parts['day']}`;
}

export function formatInvoiceAddress(address: InvoiceAddressSnapshot): string {
  return [
    address.address,
    address.street2,
    address.city,
    address.state,
    address.zip,
    address.country,
  ].filter(Boolean).join(', ');
}

function addressSnapshot(value: unknown): InvoiceAddressSnapshot | null {
  if (!isRecord(value)) return null;
  const addressId = stringValue(value['address_id']);
  const address = stringValue(value['address'] ?? value['street']);
  if (!addressId || !address) return null;
  return {
    addressId,
    address,
    ...(stringValue(value['street2']) ? { street2: stringValue(value['street2']) } : {}),
    ...(stringValue(value['city']) ? { city: stringValue(value['city']) } : {}),
    ...(stringValue(value['state']) ? { state: stringValue(value['state']) } : {}),
    ...(stringValue(value['zip']) ? { zip: stringValue(value['zip']) } : {}),
    ...(stringValue(value['country']) ? { country: stringValue(value['country']) } : {}),
  };
}

function customerAddresses(customer: Record<string, unknown>): InvoiceAddressSnapshot[] {
  const raw = [
    customer['billing_address'],
    ...(Array.isArray(customer['addresses']) ? customer['addresses'] : []),
  ];
  const byAddress = new Map<string, InvoiceAddressSnapshot>();
  for (const value of raw) {
    const snapshot = addressSnapshot(value);
    if (!snapshot) continue;
    const key = normalize(formatInvoiceAddress(snapshot));
    if (!byAddress.has(key)) byAddress.set(key, snapshot);
  }
  return [...byAddress.values()];
}

function documentKind(text: string): 'quote' | 'estimate' | undefined {
  if (/\bquote(?:\s*(?:date|#))?\b/i.test(text)) return 'quote';
  if (/\bestimate(?:\s*(?:date|#))?\b/i.test(text)) return 'estimate';
  return undefined;
}

function resolveBillingAddress(input: {
  sourceText: string;
  customer: Record<string, unknown>;
  requestedAddressId?: string | undefined;
}): InvoiceAddressSnapshot | null {
  const document = normalize(input.sourceText);
  const matches = customerAddresses(input.customer).filter(candidate => {
    if (input.requestedAddressId && candidate.addressId !== input.requestedAddressId) return false;
    // Street lines carry the identity. City, state and PIN alone are shared by
    // too many addresses and must never be enough to select one.
    const street = normalize(candidate.address);
    return street.length >= 8 && document.includes(street);
  });
  return matches.length === 1 ? matches[0]! : null;
}

export function applyInvoiceSourcePolicy(input: {
  readonly payload: Record<string, unknown>;
  readonly sourceDocument?: { readonly fileName: string; readonly text: string } | undefined;
  readonly chosenCustomer?: Record<string, unknown> | undefined;
  readonly now: Date;
  readonly organizationTimeZone?: string | undefined;
}): InvoiceSourcePolicyResult {
  const payload = { ...input.payload };
  const notes: string[] = [];
  const sourcePolicy: InvoiceSourcePolicySnapshot = {};
  const document = input.sourceDocument;
  const kind = document ? documentKind(document.text) : undefined;
  const originalDate = stringValue(payload['date']);
  const originalDueDate = stringValue(payload['due_date']);
  const invoiceDate = dateInTimeZone(input.now, input.organizationTimeZone);
  payload['date'] = invoiceDate;

  let nextDueDate = originalDueDate;
  const issueDay = epochDay(originalDate);
  const dueDay = epochDay(originalDueDate);
  if (issueDay !== null && dueDay !== null && dueDay >= issueDay) {
    nextDueDate = addDays(invoiceDate, dueDay - issueDay);
    payload['due_date'] = nextDueDate;
  }

  Object.assign(sourcePolicy, {
    ...(kind ? { documentKind: kind } : {}),
    ...(originalDate ? { originalDocumentDate: originalDate } : {}),
    invoiceDate,
  });
  if (originalDate !== invoiceDate) {
    const sourceLabel = kind === 'quote'
      ? 'Quote date'
      : kind === 'estimate'
        ? 'Estimate date'
        : 'Requested date';
    notes.push(
      `${sourceLabel} ${originalDate || '(missing)'} kept as source evidence; `
      + `invoice date set to creation date ${invoiceDate}`
      + (nextDueDate && nextDueDate !== originalDueDate ? ` and due date moved to ${nextDueDate}` : ''),
    );
  }

  if (document && /\bbill\s+to\b/i.test(document.text)) {
    if (!input.chosenCustomer) {
      return {
        ok: false,
        message: 'Divo could not read the selected customer record, so it cannot verify the document billing address. Nothing was staged.',
      };
    }
    const requestedAddressId = stringValue(payload['billing_address_id']);
    const billingAddress = resolveBillingAddress({
      sourceText: document.text,
      customer: input.chosenCustomer,
      ...(requestedAddressId ? { requestedAddressId } : {}),
    });
    if (!billingAddress) {
      return {
        ok: false,
        message: requestedAddressId
          ? 'The billing address selected for this draft does not match the Bill To address in the source document. Nothing was staged.'
          : 'The Bill To address in the source document does not uniquely match a saved address for this customer. Nothing was staged; ask the member which saved address to use or correct the customer record first.',
      };
    }
    payload['billing_address_id'] = billingAddress.addressId;
    Object.assign(sourcePolicy, { billingAddress });
  }

  return { ok: true, payload, notes, sourcePolicy };
}
