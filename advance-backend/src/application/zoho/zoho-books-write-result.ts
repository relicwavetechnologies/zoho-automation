/**
 * Shapes what Zoho Books returns from a write into what the member is told.
 *
 * Every write used to answer with an id and a fixed sentence, which is how
 * "Invoice created successfully" came to describe a draft nobody would ever be
 * billed for. Zoho returns the whole record; this reads the parts that decide
 * whether the work is actually done, and says them.
 *
 * Pure on purpose — no client, no context — so the honesty rules here are
 * testable without reaching Zoho.
 */

import { formatAmount } from './zoho-format.utils';

export type ZohoWriteModule =
  | 'invoices'
  | 'purchaseorders'
  | 'bills'
  | 'expenses'
  | 'contacts'
  | 'customerpayments';

export interface ZohoWriteSummary {
  readonly id: string;
  readonly message: string;
  readonly recordUrl?: string;
  /** Filenames Zoho reports as attached, when the record carries any. */
  readonly documents: readonly string[];
}

const idKeys: Record<ZohoWriteModule, readonly string[]> = {
  invoices:         ['invoice_id'],
  purchaseorders:   ['purchaseorder_id'],
  bills:            ['bill_id'],
  expenses:         ['expense_id'],
  contacts:         ['contact_id'],
  customerpayments: ['payment_id'],
};

const numberKeys: Record<ZohoWriteModule, readonly string[]> = {
  invoices:         ['invoice_number'],
  purchaseorders:   ['purchaseorder_number'],
  bills:            ['bill_number'],
  expenses:         ['expense_number', 'reference_number'],
  contacts:         ['contact_name', 'company_name'],
  customerpayments: ['payment_number'],
};

const label: Record<ZohoWriteModule, string> = {
  invoices:         'Invoice',
  purchaseorders:   'Purchase order',
  bills:            'Bill',
  expenses:         'Expense',
  contacts:         'Contact',
  customerpayments: 'Payment',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (record: Record<string, unknown>, keys: readonly string[]): string => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

const numeric = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Wrapper keys that do not follow from the module name.
 *
 * `/customerpayments` answers with `{ payment: … }`, so deriving the key by
 * stripping the trailing "s" finds nothing and the whole record is lost —
 * which is exactly how a recorded payment came back with no id.
 */
const wrapperKeys: Record<string, readonly string[]> = {
  customerpayments: ['payment', 'customerpayment'],
  vendorpayments:   ['payment', 'vendorpayment'],
  chartofaccounts:  ['chart_of_account'],
};

/**
 * Zoho returns the record wrapped in its singular module name — `{ invoice: {…} }`.
 * Some endpoints answer with the plural or with a name of their own, so try the
 * known keys before falling back to the payload itself.
 */
export function unwrapZohoRecord(
  payload: Record<string, unknown>,
  module: string,
): Record<string, unknown> {
  const candidates = [
    ...(wrapperKeys[module] ?? []),
    module.replace(/s$/, ''),
    module,
  ];
  for (const key of candidates) {
    const inner = payload[key];
    if (isRecord(inner)) return inner;
  }
  return payload;
}

/** Filenames Zoho lists under `documents[]`, which is how attachment state is verified. */
export function attachedDocumentNames(record: Record<string, unknown>): string[] {
  const documents = record['documents'];
  if (!Array.isArray(documents)) return [];
  return documents
    .filter(isRecord)
    .map(document => text(document, ['file_name', 'document_name', 'name']))
    .filter(name => name.length > 0);
}

export function zohoRecordUrl(input: {
  appBaseUrl: string;
  organizationId?: string | undefined;
  module: ZohoWriteModule;
  recordId: string;
}): string | undefined {
  if (!input.organizationId || !input.recordId) return undefined;
  const base = input.appBaseUrl.replace(/\/$/, '');
  return `${base}/app/${input.organizationId}#/${input.module}/${input.recordId}`;
}

/**
 * `verb` is what actually happened — "created", "updated", "voided" — never a
 * claim the record's own status contradicts.
 */
export function summarizeZohoWrite(input: {
  module: ZohoWriteModule;
  verb: string;
  record: Record<string, unknown>;
  appBaseUrl: string;
  organizationId?: string | undefined;
}): ZohoWriteSummary {
  const { module, record } = input;
  const id = text(record, idKeys[module]);
  const reference = text(record, numberKeys[module]);
  const status = text(record, ['status']);
  const currency = text(record, ['currency_code']);
  const documents = attachedDocumentNames(record);

  const head = [label[module], reference].filter(Boolean).join(' ');
  const parts: string[] = [`${head || label[module]} ${input.verb} in Zoho Books`];

  if (status) parts.push(`status ${status}`);

  const total = numeric(record['total']);
  if (total !== null && currency) parts.push(`total ${formatAmount(total, currency)}`);

  const balance = numeric(record['balance']);
  if (balance !== null && currency && balance !== total) {
    parts.push(`balance ${formatAmount(balance, currency)}`);
  }

  let message = `${parts.join(', ')}.`;

  // A draft is not a bill anyone has received. Say so here rather than letting
  // "created successfully" imply the customer has been asked to pay.
  if ((module === 'invoices' || module === 'purchaseorders') && status.toLowerCase() === 'draft') {
    message += module === 'invoices'
      ? ' It is still a draft — nothing has been sent to the customer yet.'
      : ' It is still a draft — nothing has been sent to the vendor yet.';
  }

  // Only invoices and bills carry documents, and only there does their absence
  // mean something the member needs to hear.
  if (module === 'invoices' || module === 'purchaseorders' || module === 'bills') {
    message += documents.length > 0
      ? ` Attached: ${documents.join(', ')}.`
      : ' No file is attached to it.';
  }

  const url = zohoRecordUrl({
    appBaseUrl: input.appBaseUrl,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    module,
    recordId: id,
  });

  return {
    id,
    message,
    documents,
    ...(url ? { recordUrl: url } : {}),
  };
}
