import { hotContextStore } from '../../../hot-context.store';
import type { VercelRuntimeRequestContext } from '../../types';

export type ZohoSourceType =
  | 'zoho_lead'
  | 'zoho_contact'
  | 'zoho_account'
  | 'zoho_deal'
  | 'zoho_ticket';

export type ZohoBooksRuntimeModule =
  | 'contacts'
  | 'invoices'
  | 'estimates'
  | 'creditnotes'
  | 'bills'
  | 'salesorders'
  | 'purchaseorders'
  | 'customerpayments'
  | 'vendorpayments'
  | 'bankaccounts'
  | 'banktransactions';

export const buildBooksMutationAuthorizationTarget = (input: {
  operation: string;
  moduleName?: string;
  recordId?: string;
  accountId?: string;
  transactionId?: string;
  invoiceId?: string;
  estimateId?: string;
  creditNoteId?: string;
  salesOrderId?: string;
  purchaseOrderId?: string;
  billId?: string;
  contactId?: string;
  vendorPaymentId?: string;
  organizationId?: string;
}): Record<string, unknown> => {
  let module = input.moduleName;
  let recordId = input.recordId;

  if (
    ['activateBankAccount', 'deactivateBankAccount', 'importBankStatement'].includes(
      input.operation,
    )
  ) {
    module = 'bankaccounts';
    recordId = input.accountId;
  } else if (
    [
      'matchBankTransaction',
      'unmatchBankTransaction',
      'excludeBankTransaction',
      'restoreBankTransaction',
      'uncategorizeBankTransaction',
      'categorizeBankTransaction',
      'categorizeBankTransactionAsExpense',
      'categorizeBankTransactionAsVendorPayment',
      'categorizeBankTransactionAsCustomerPayment',
      'categorizeBankTransactionAsCreditNoteRefund',
    ].includes(input.operation)
  ) {
    module = 'banktransactions';
    recordId = input.transactionId;
  } else if (
    [
      'emailInvoice',
      'remindInvoice',
      'enableInvoicePaymentReminder',
      'disableInvoicePaymentReminder',
      'writeOffInvoice',
      'cancelInvoiceWriteOff',
      'markInvoiceSent',
      'voidInvoice',
      'markInvoiceDraft',
      'submitInvoice',
      'approveInvoice',
    ].includes(input.operation)
  ) {
    module = 'invoices';
    recordId = input.invoiceId;
  } else if (
    [
      'emailEstimate',
      'markEstimateSent',
      'acceptEstimate',
      'declineEstimate',
      'submitEstimate',
      'approveEstimate',
    ].includes(input.operation)
  ) {
    module = 'estimates';
    recordId = input.estimateId;
  } else if (
    ['emailCreditNote', 'openCreditNote', 'voidCreditNote', 'refundCreditNote'].includes(
      input.operation,
    )
  ) {
    module = 'creditnotes';
    recordId = input.creditNoteId;
  } else if (
    [
      'emailSalesOrder',
      'openSalesOrder',
      'voidSalesOrder',
      'submitSalesOrder',
      'approveSalesOrder',
      'createInvoiceFromSalesOrder',
    ].includes(input.operation)
  ) {
    module = 'salesorders';
    recordId = input.salesOrderId;
  } else if (
    [
      'emailPurchaseOrder',
      'openPurchaseOrder',
      'billPurchaseOrder',
      'cancelPurchaseOrder',
      'rejectPurchaseOrder',
      'submitPurchaseOrder',
      'approvePurchaseOrder',
    ].includes(input.operation)
  ) {
    module = 'purchaseorders';
    recordId = input.purchaseOrderId;
  } else if (['voidBill', 'openBill', 'submitBill', 'approveBill'].includes(input.operation)) {
    module = 'bills';
    recordId = input.billId;
  } else if (
    [
      'emailContact',
      'emailContactStatement',
      'enableContactPaymentReminder',
      'disableContactPaymentReminder',
    ].includes(input.operation)
  ) {
    module = 'contacts';
    recordId = input.contactId;
  } else if (input.operation === 'emailVendorPayment') {
    module = 'vendorpayments';
    recordId = input.vendorPaymentId;
  }

  return {
    domain: 'books',
    module,
    operation: input.operation,
    recordId,
    organizationId: input.organizationId,
  };
};

export const buildCrmMutationAuthorizationTarget = (input: {
  operation: string;
  moduleName?: string;
  recordId?: string;
}): Record<string, unknown> => ({
  domain: 'crm',
  module: input.moduleName,
  operation: input.operation,
  recordId: input.recordId,
});

export const normalizeZohoSourceType = (value?: string): ZohoSourceType | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (['leads', 'lead', 'zoho_lead'].includes(normalized)) return 'zoho_lead';
  if (['contacts', 'contact', 'zoho_contact'].includes(normalized)) return 'zoho_contact';
  if (['accounts', 'account', 'companies', 'company', 'zoho_account'].includes(normalized))
    return 'zoho_account';
  if (['deals', 'deal', 'zoho_deal'].includes(normalized)) return 'zoho_deal';
  if (['cases', 'case', 'tickets', 'ticket', 'zoho_ticket'].includes(normalized))
    return 'zoho_ticket';
  return undefined;
};

export const normalizeZohoCrmModuleName = (value?: string): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (['leads', 'lead', 'zoho_lead'].includes(normalized)) return 'Leads';
  if (['contacts', 'contact', 'zoho_contact'].includes(normalized)) return 'Contacts';
  if (['accounts', 'account', 'companies', 'company', 'zoho_account'].includes(normalized))
    return 'Accounts';
  if (['deals', 'deal', 'zoho_deal'].includes(normalized)) return 'Deals';
  if (['cases', 'case', 'tickets', 'ticket', 'zoho_ticket'].includes(normalized)) return 'Cases';
  if (['tasks', 'task'].includes(normalized)) return 'Tasks';
  if (['events', 'event', 'meetings', 'meeting'].includes(normalized)) return 'Events';
  if (['calls', 'call'].includes(normalized)) return 'Calls';
  if (['products', 'product'].includes(normalized)) return 'Products';
  if (['quotes', 'quote'].includes(normalized)) return 'Quotes';
  if (['vendors', 'vendor'].includes(normalized)) return 'Vendors';
  if (['invoices', 'invoice'].includes(normalized)) return 'Invoices';
  if (['salesorders', 'salesorder', 'sales_orders', 'sales-order'].includes(normalized))
    return 'Sales_Orders';
  if (['purchaseorders', 'purchaseorder', 'purchase_orders', 'purchase-order'].includes(normalized))
    return 'Purchase_Orders';
  return value?.trim();
};

export const normalizeZohoBooksModule = (
  value?: string,
): ZohoBooksRuntimeModule | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (['contact', 'contacts', 'customer', 'customers', 'vendor', 'vendors'].includes(normalized))
    return 'contacts';
  if (['invoice', 'invoices'].includes(normalized)) return 'invoices';
  if (['estimate', 'estimates'].includes(normalized)) return 'estimates';
  if (['creditnote', 'creditnotes', 'credit-note', 'credit-notes'].includes(normalized))
    return 'creditnotes';
  if (['bill', 'bills'].includes(normalized)) return 'bills';
  if (['salesorder', 'salesorders', 'sales-order', 'sales-orders'].includes(normalized))
    return 'salesorders';
  if (['purchaseorder', 'purchaseorders', 'purchase-order', 'purchase-orders'].includes(normalized))
    return 'purchaseorders';
  if (['customerpayment', 'customerpayments', 'payment', 'payments'].includes(normalized))
    return 'customerpayments';
  if (['vendorpayment', 'vendorpayments', 'vendor-payment', 'vendor-payments'].includes(normalized))
    return 'vendorpayments';
  if (
    [
      'bankaccount',
      'bankaccounts',
      'bank-account',
      'bank-accounts',
      'account',
      'accounts',
    ].includes(normalized)
  ) {
    return 'bankaccounts';
  }
  if (
    ['banktransaction', 'banktransactions', 'bank-transaction', 'bank-transactions'].includes(
      normalized,
    )
  ) {
    return 'banktransactions';
  }
  return undefined;
};

export const isZohoBooksContactStatementModuleAlias = (value?: string): boolean => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return [
    'statement',
    'statements',
    'contactstatement',
    'contactstatements',
    'customerstatement',
    'customerstatements',
    'accountstatement',
    'accountstatements',
  ].includes(normalized);
};

const getRuntimeZohoBooksEntity = (
  runtime: VercelRuntimeRequestContext,
  moduleName: ZohoBooksRuntimeModule,
): { module: ZohoBooksRuntimeModule; recordId: string } | null => {
  const currentEntity = runtime.taskState?.currentEntity;
  const currentModule = normalizeZohoBooksModule(currentEntity?.module);
  if (currentModule === moduleName && currentEntity?.recordId?.trim()) {
    return {
      module: currentModule,
      recordId: currentEntity.recordId.trim(),
    };
  }

  const lastFetched = runtime.taskState?.lastFetchedByModule?.[moduleName];
  const lastFetchedModule = normalizeZohoBooksModule(lastFetched?.module);
  if (lastFetchedModule === moduleName && lastFetched?.recordId?.trim()) {
    return {
      module: lastFetchedModule,
      recordId: lastFetched.recordId.trim(),
    };
  }

  return null;
};

const inferZohoBooksModuleFromOperation = (
  operation: string,
): ZohoBooksRuntimeModule | undefined => {
  if (
    [
      'emailEstimate',
      'markEstimateSent',
      'acceptEstimate',
      'declineEstimate',
      'submitEstimate',
      'approveEstimate',
      'getEstimateEmailContent',
    ].includes(operation)
  ) {
    return 'estimates';
  }
  if (
    [
      'emailInvoice',
      'remindInvoice',
      'enableInvoicePaymentReminder',
      'disableInvoicePaymentReminder',
      'writeOffInvoice',
      'cancelInvoiceWriteOff',
      'markInvoiceSent',
      'voidInvoice',
      'markInvoiceDraft',
      'submitInvoice',
      'approveInvoice',
      'getInvoiceEmailContent',
      'getInvoicePaymentReminderContent',
    ].includes(operation)
  ) {
    return 'invoices';
  }
  if (
    [
      'emailCreditNote',
      'openCreditNote',
      'voidCreditNote',
      'refundCreditNote',
      'getCreditNoteEmailContent',
    ].includes(operation)
  ) {
    return 'creditnotes';
  }
  if (
    [
      'emailSalesOrder',
      'openSalesOrder',
      'voidSalesOrder',
      'submitSalesOrder',
      'approveSalesOrder',
      'createInvoiceFromSalesOrder',
      'getSalesOrderEmailContent',
    ].includes(operation)
  ) {
    return 'salesorders';
  }
  if (
    [
      'emailPurchaseOrder',
      'openPurchaseOrder',
      'billPurchaseOrder',
      'cancelPurchaseOrder',
      'rejectPurchaseOrder',
      'submitPurchaseOrder',
      'approvePurchaseOrder',
      'getPurchaseOrderEmailContent',
    ].includes(operation)
  ) {
    return 'purchaseorders';
  }
  if (['voidBill', 'openBill', 'submitBill', 'approveBill'].includes(operation)) {
    return 'bills';
  }
  if (
    [
      'emailContact',
      'emailContactStatement',
      'enableContactPaymentReminder',
      'disableContactPaymentReminder',
      'getContactStatementEmailContent',
    ].includes(operation)
  ) {
    return 'contacts';
  }
  if (['emailVendorPayment', 'getVendorPaymentEmailContent'].includes(operation)) {
    return 'vendorpayments';
  }
  return undefined;
};

export const resolveZohoBooksModuleFromRuntime = (
  runtime: VercelRuntimeRequestContext,
  explicitModule: string | undefined,
  operation: string,
): ZohoBooksRuntimeModule | undefined => {
  const explicit = normalizeZohoBooksModule(explicitModule);
  if (explicit) {
    return explicit;
  }
  const inferred = inferZohoBooksModuleFromOperation(operation);
  if (inferred) {
    const entity = getRuntimeZohoBooksEntity(runtime, inferred);
    if (entity) {
      return entity.module;
    }
    return inferred;
  }
  const currentEntityModule = normalizeZohoBooksModule(runtime.taskState?.currentEntity?.module);
  if (currentEntityModule) {
    return currentEntityModule;
  }
  const activeModule = normalizeZohoBooksModule(runtime.taskState?.activeModule);
  return activeModule;
};

export const resolveZohoBooksRecordIdFromRuntime = (
  runtime: VercelRuntimeRequestContext,
  moduleName: ZohoBooksRuntimeModule | undefined,
  explicitRecordId?: string,
): string | undefined => {
  const direct = explicitRecordId?.trim();
  if (direct) {
    return direct;
  }
  if (!moduleName) {
    return undefined;
  }
  const runtimeEntityRecordId = getRuntimeZohoBooksEntity(runtime, moduleName)?.recordId;
  if (runtimeEntityRecordId?.trim()) {
    return runtimeEntityRecordId.trim();
  }
  const taskId = runtime.executionId;
  const preferredKeys = moduleName === 'invoices'
    ? ['invoiceId', 'invoice_id', 'recordId', 'record_id']
    : moduleName === 'estimates'
      ? ['estimateId', 'estimate_id', 'recordId', 'record_id']
      : moduleName === 'contacts'
        ? ['contactId', 'contact_id', 'recordId', 'record_id']
        : ['recordId', 'record_id'];
  for (const key of preferredKeys) {
    const resolved = hotContextStore.getResolvedId(taskId, key);
    if (resolved?.trim()) {
      return resolved.trim();
    }
  }
  return undefined;
};

export const resolveZohoBooksModuleScopedExplicitRecordId = (input: {
  moduleName: ZohoBooksRuntimeModule | undefined;
  recordId?: string;
  invoiceId?: string;
  estimateId?: string;
  creditNoteId?: string;
  salesOrderId?: string;
  purchaseOrderId?: string;
  billId?: string;
  contactId?: string;
  vendorPaymentId?: string;
  accountId?: string;
  transactionId?: string;
}): string | undefined => {
  const direct = input.recordId?.trim();
  if (direct) {
    return direct;
  }
  switch (input.moduleName) {
    case 'invoices':
      return input.invoiceId?.trim();
    case 'estimates':
      return input.estimateId?.trim();
    case 'creditnotes':
      return input.creditNoteId?.trim();
    case 'salesorders':
      return input.salesOrderId?.trim();
    case 'purchaseorders':
      return input.purchaseOrderId?.trim();
    case 'bills':
      return input.billId?.trim();
    case 'contacts':
      return input.contactId?.trim();
    case 'vendorpayments':
      return input.vendorPaymentId?.trim();
    case 'bankaccounts':
      return input.accountId?.trim();
    case 'banktransactions':
      return input.transactionId?.trim();
    default:
      return undefined;
  }
};

export const resolvePendingBooksWriteBodyFromRuntime = (input: {
  runtime: VercelRuntimeRequestContext;
  operation: string;
  moduleName?: ZohoBooksRuntimeModule;
  recordId?: string;
  explicitBody?: Record<string, unknown>;
  asRecord: (value: unknown) => Record<string, unknown> | null;
  asString: (value: unknown) => string | undefined;
}): Record<string, unknown> | undefined => {
  if (input.explicitBody) {
    return input.explicitBody;
  }
  const pendingApproval = input.runtime.taskState?.pendingApproval;
  if (!pendingApproval || pendingApproval.toolId !== 'zoho-books-write') {
    return undefined;
  }
  const pendingModule = normalizeZohoBooksModule(pendingApproval.module);
  const pendingPayload = input.asRecord(pendingApproval.payload);
  const pendingBody = input.asRecord(pendingPayload?.body);
  const pendingRecordId = input.asString(pendingApproval.recordId) ?? input.asString(pendingPayload?.recordId);
  if (!pendingBody) {
    return undefined;
  }
  if (pendingApproval.operation !== input.operation) {
    return undefined;
  }
  if (input.moduleName && pendingModule && input.moduleName !== pendingModule) {
    return undefined;
  }
  if (input.recordId?.trim() && pendingRecordId && input.recordId.trim() !== pendingRecordId) {
    return undefined;
  }
  return pendingBody;
};
