import type { VercelToolEnvelope } from '../../types';

export const BOOKS_MODULE_PROJECTION: Record<string, string[]> = {
  invoices: ['invoice_id', 'invoice_number', 'customer_name', 'total', 'balance', 'due_date', 'status', 'currency_code'],
  contacts: ['contact_id', 'contact_name', 'company_name', 'email', 'outstanding_receivable_amount', 'outstanding_payable_amount', 'status'],
  bills: ['bill_id', 'bill_number', 'vendor_name', 'total', 'balance', 'due_date', 'status', 'currency_code'],
  estimates: ['estimate_id', 'estimate_number', 'customer_name', 'total', 'expiry_date', 'status', 'currency_code'],
  creditnotes: ['creditnote_id', 'creditnote_number', 'customer_name', 'total', 'balance', 'status', 'currency_code'],
  salesorders: ['salesorder_id', 'salesorder_number', 'customer_name', 'total', 'status', 'shipment_date', 'currency_code'],
  purchaseorders: ['purchaseorder_id', 'purchaseorder_number', 'vendor_name', 'total', 'status', 'delivery_date', 'currency_code'],
  payments: ['payment_id', 'payment_number', 'customer_name', 'amount', 'payment_date', 'payment_mode', 'invoice_numbers'],
  vendorpayments: ['vendorpayment_id', 'payment_number', 'vendor_name', 'amount', 'payment_date', 'payment_mode'],
  banktransactions: ['transaction_id', 'date', 'payee', 'debit_amount', 'credit_amount', 'status', 'account_name'],
  accounts: ['account_id', 'account_name', 'account_type', 'current_balance', 'currency_code'],
  expenses: ['expense_id', 'date', 'vendor_name', 'total', 'status', 'account_name', 'currency_code'],
};

export const BOOKS_LARGE_RESULT_THRESHOLD = 40;

export const projectRecord = (
  record: Record<string, unknown>,
  moduleName: string,
): Record<string, unknown> => {
  const fields = BOOKS_MODULE_PROJECTION[moduleName];
  if (!fields) {
    return record;
  }
  return Object.fromEntries(
    fields
      .filter((field) => record[field] !== undefined && record[field] !== null)
      .map((field) => [field, record[field]]),
  );
};

export const buildBooksReadRecordsEnvelope = (input: {
  moduleName: string;
  organizationId?: string;
  resultItems: Array<Record<string, unknown>>;
  raw?: Record<string, unknown>;
  summarizeOnly?: boolean;
  buildEnvelope: (payload: Record<string, unknown>) => VercelToolEnvelope;
  asString: (value: unknown) => string | undefined;
}): VercelToolEnvelope => {
  const isLargeResult = input.resultItems.length > BOOKS_LARGE_RESULT_THRESHOLD;
  const projectedItems = isLargeResult
    ? input.resultItems.map((item) => projectRecord(item, input.moduleName))
    : input.resultItems;
  const projectionNote = isLargeResult
    ? ' Results projected to essential fields to stay within context limits.'
    : '';

  if (input.summarizeOnly) {
    const statusCounts = input.resultItems.reduce<Record<string, number>>((acc, item) => {
      const status = input.asString(item.status) ?? 'unknown';
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {});
    return input.buildEnvelope({
      success: true,
      summary:
        (input.resultItems.length > 0
          ? `Summarized ${input.resultItems.length} Zoho Books ${input.moduleName} record(s).`
          : `No Zoho Books ${input.moduleName} records matched the current filters.`) + projectionNote,
      keyData: {
        module: input.moduleName,
        organizationId: input.organizationId,
        recordCount: input.resultItems.length,
        resultCount: input.resultItems.length,
        statusCounts,
        ...(isLargeResult
          ? { projectedFields: BOOKS_MODULE_PROJECTION[input.moduleName] ?? null }
          : {}),
      },
      fullPayload: {
        organizationId: input.organizationId,
        statusCounts,
        records: projectedItems,
        ...(isLargeResult ? {} : { raw: input.raw }),
      },
    });
  }

  return input.buildEnvelope({
    success: true,
    summary:
      (input.resultItems.length > 0
        ? `Found ${input.resultItems.length} Zoho Books ${input.moduleName} record(s).`
        : `No Zoho Books ${input.moduleName} records matched the current filters.`) + projectionNote,
    keyData: {
      module: input.moduleName,
      organizationId: input.organizationId,
      recordCount: input.resultItems.length,
      resultCount: input.resultItems.length,
      ...(isLargeResult
        ? { projectedFields: BOOKS_MODULE_PROJECTION[input.moduleName] ?? null }
        : {}),
    },
    fullPayload: {
      organizationId: input.organizationId,
      records: projectedItems,
      ...(isLargeResult ? {} : { raw: input.raw }),
    },
    citations: projectedItems.flatMap((record, index) => {
      const recordId =
        input.asString(record.contact_id) ??
        input.asString(record.vendor_payment_id) ??
        input.asString(record.account_id) ??
        input.asString(record.invoice_id) ??
        input.asString(record.estimate_id) ??
        input.asString(record.creditnote_id) ??
        input.asString(record.bill_id) ??
        input.asString(record.salesorder_id) ??
        input.asString(record.purchaseorder_id) ??
        input.asString(record.payment_id) ??
        input.asString(record.bank_transaction_id) ??
        input.asString(record.transaction_id);
      if (!recordId) {
        return [];
      }
      return [
        {
          id: `books-${input.moduleName}-${index + 1}`,
          title: `${input.moduleName}:${recordId}`,
          kind: 'record',
          sourceType: input.moduleName,
          sourceId: recordId,
        },
      ];
    }),
  });
};
