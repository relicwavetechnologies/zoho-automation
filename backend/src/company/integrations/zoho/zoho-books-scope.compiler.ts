import { extractNormalizedEmails, normalizeEmail } from './zoho-email-scope';
import type { ZohoBooksModule } from './zoho-books.client';
import type { ZohoRecordOwnershipVerdict } from './zoho-gateway.types';

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

export const SELF_SCOPABLE_BOOKS_MODULES = new Set<ZohoBooksModule>([
  'contacts',
  'estimates',
  'invoices',
  'creditnotes',
  'salesorders',
  'customerpayments',
]);

export const FINANCE_ONLY_BOOKS_MODULES = new Set<ZohoBooksModule>([
  'bills',
  'purchaseorders',
  'vendorpayments',
  'bankaccounts',
  'banktransactions',
]);

export const normalizeBooksGatewayModule = (value?: string): ZohoBooksModule | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'contacts' || normalized === 'contact') return 'contacts';
  if (normalized === 'estimates' || normalized === 'estimate') return 'estimates';
  if (normalized === 'invoices' || normalized === 'invoice') return 'invoices';
  if (normalized === 'creditnotes' || normalized === 'creditnote' || normalized === 'credit_note') return 'creditnotes';
  if (normalized === 'salesorders' || normalized === 'salesorder' || normalized === 'sales_order') return 'salesorders';
  if (normalized === 'customerpayments' || normalized === 'customerpayment' || normalized === 'payment') return 'customerpayments';
  if (normalized === 'bills' || normalized === 'bill') return 'bills';
  if (normalized === 'purchaseorders' || normalized === 'purchaseorder' || normalized === 'purchase_order') return 'purchaseorders';
  if (normalized === 'vendorpayments' || normalized === 'vendorpayment') return 'vendorpayments';
  if (normalized === 'bankaccounts' || normalized === 'bankaccount') return 'bankaccounts';
  if (normalized === 'banktransactions' || normalized === 'banktransaction' || normalized === 'transaction') return 'banktransactions';
  return undefined;
};

export const isBooksFinanceOnlyModule = (moduleName: ZohoBooksModule): boolean =>
  FINANCE_ONLY_BOOKS_MODULES.has(moduleName);

export const canSelfScopeBooksModule = (moduleName: ZohoBooksModule): boolean =>
  SELF_SCOPABLE_BOOKS_MODULES.has(moduleName);

export const compileBooksNativeFilters = (input: {
  moduleName: ZohoBooksModule;
  scopeMode?: 'self_scoped' | 'company_scoped';
  requesterEmail?: string;
  allowedContactIds?: string[];
  filters?: Record<string, unknown>;
}): Record<string, unknown> => {
  const compiled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.filters ?? {})) {
    if (typeof key !== 'string' || key.trim().length === 0) continue;
    if (typeof value === 'string' && value.trim().length > 0) {
      compiled[key] = value.trim();
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      compiled[key] = value;
    }
  }

  const allowedContactIds = (input.allowedContactIds ?? []).filter(Boolean);
  const normalizedRequesterEmail = normalizeEmail(input.requesterEmail);
  if (input.moduleName === 'contacts' && input.scopeMode === 'self_scoped' && normalizedRequesterEmail) {
    compiled.email = normalizedRequesterEmail;
  } else if (
    ['estimates', 'invoices', 'creditnotes', 'salesorders', 'customerpayments'].includes(input.moduleName)
    && allowedContactIds.length === 1
  ) {
    compiled.customer_id = allowedContactIds[0];
  }

  return compiled;
};

const readBooksRecordPrimaryId = (record: Record<string, unknown>, moduleName: ZohoBooksModule): string | undefined => {
  if (moduleName === 'contacts') return asString(record.contact_id) ?? asString(record.id);
  if (moduleName === 'estimates') return asString(record.estimate_id) ?? asString(record.id);
  if (moduleName === 'invoices') return asString(record.invoice_id) ?? asString(record.id);
  if (moduleName === 'creditnotes') return asString(record.creditnote_id) ?? asString(record.id);
  if (moduleName === 'salesorders') return asString(record.salesorder_id) ?? asString(record.id);
  if (moduleName === 'customerpayments') return asString(record.payment_id) ?? asString(record.customer_payment_id) ?? asString(record.id);
  if (moduleName === 'vendorpayments') return asString(record.vendor_payment_id) ?? asString(record.id);
  if (moduleName === 'bills') return asString(record.bill_id) ?? asString(record.id);
  if (moduleName === 'purchaseorders') return asString(record.purchaseorder_id) ?? asString(record.id);
  if (moduleName === 'bankaccounts') return asString(record.account_id) ?? asString(record.id);
  return asString(record.bank_transaction_id) ?? asString(record.transaction_id) ?? asString(record.id);
};

export const getBooksRecordId = readBooksRecordPrimaryId;

export const verifyBooksRecordOwnership = (input: {
  moduleName: ZohoBooksModule;
  payload: Record<string, unknown>;
  requesterEmail?: string;
  allowedContactIds?: string[];
}): ZohoRecordOwnershipVerdict => {
  const normalizedRequesterEmail = normalizeEmail(input.requesterEmail);
  const matchedBy: string[] = [];
  const allowedContactIds = new Set((input.allowedContactIds ?? []).filter(Boolean));
  const record = input.payload;

  const candidateIds = [
    asString(record.contact_id),
    asString(record.customer_id),
    asString(record.customerId),
    asString(record.contactId),
  ].filter((value): value is string => Boolean(value));

  if (candidateIds.some((candidate) => allowedContactIds.has(candidate))) {
    matchedBy.push('contact_id');
  }

  if (input.moduleName === 'contacts') {
    const selfId = readBooksRecordPrimaryId(record, input.moduleName);
    if (selfId && allowedContactIds.has(selfId)) {
      matchedBy.push('record_id');
    }
  }

  if (normalizedRequesterEmail) {
    const emails = extractNormalizedEmails(record);
    if (emails.includes(normalizedRequesterEmail)) {
      matchedBy.push('payload_email');
    }
  }

  return {
    allowed: matchedBy.length > 0,
    reason: matchedBy.length > 0 ? undefined : 'ownership_not_matched',
    matchedBy,
  };
};
