import { Buffer } from 'buffer';

import { prisma } from '../../../utils/prisma';
import { logger } from '../../../utils/logger';
import { ZohoIntegrationError } from './zoho.errors';
import { zohoHttpClient, ZohoHttpClient, type ZohoRawResponse } from './zoho-http.client';
import { zohoTokenService, ZohoTokenService } from './zoho-token.service';

export type ZohoBooksModule =
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

type ZohoBooksClientOptions = {
  httpClient?: ZohoHttpClient;
  tokenService?: Pick<ZohoTokenService, 'getValidAccessToken' | 'forceRefresh'>;
};

type ZohoBooksResponse = Record<string, unknown>;

type ZohoBooksOrganization = {
  organizationId: string;
  name?: string;
  isDefault?: boolean;
  raw: Record<string, unknown>;
};

type ZohoBooksScopedResult = {
  organizationId: string;
  payload: ZohoBooksResponse;
};

type ZohoBooksRawScopedResult = {
  organizationId: string;
  payload: ZohoRawResponse;
};

type ZohoBooksCommentModule =
  | 'invoices'
  | 'estimates'
  | 'creditnotes'
  | 'bills'
  | 'salesorders'
  | 'purchaseorders';

type ZohoBooksDocumentModule =
  | 'invoices'
  | 'estimates'
  | 'creditnotes'
  | 'bills'
  | 'salesorders'
  | 'purchaseorders';

const BOOKS_MODULE_KEYS: Record<ZohoBooksModule, { listKey: string; singularKeys: string[]; label: string }> = {
  contacts: { listKey: 'contacts', singularKeys: ['contact'], label: 'contact' },
  invoices: { listKey: 'invoices', singularKeys: ['invoice'], label: 'invoice' },
  estimates: { listKey: 'estimates', singularKeys: ['estimate'], label: 'estimate' },
  creditnotes: { listKey: 'creditnotes', singularKeys: ['creditnote', 'credit_note'], label: 'credit note' },
  bills: { listKey: 'bills', singularKeys: ['bill'], label: 'bill' },
  salesorders: { listKey: 'salesorders', singularKeys: ['salesorder', 'sales_order'], label: 'sales order' },
  purchaseorders: { listKey: 'purchaseorders', singularKeys: ['purchaseorder', 'purchase_order'], label: 'purchase order' },
  customerpayments: { listKey: 'customerpayments', singularKeys: ['customerpayment', 'payment'], label: 'customer payment' },
  vendorpayments: { listKey: 'vendorpayments', singularKeys: ['vendorpayment', 'payment'], label: 'vendor payment' },
  bankaccounts: { listKey: 'bankaccounts', singularKeys: ['bankaccount', 'account'], label: 'bank account' },
  banktransactions: { listKey: 'banktransactions', singularKeys: ['banktransaction', 'transaction'], label: 'bank transaction' },
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const asArrayOfRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];

const tokenMetadataToRecord = (value: unknown): Record<string, unknown> | undefined =>
  asRecord(value);

const readOrganizationIdFromMetadata = (metadata: Record<string, unknown> | undefined): string | undefined => {
  if (!metadata) {
    return undefined;
  }
  return asString(metadata.organizationId)
    ?? asString(metadata.organization_id)
    ?? asString(metadata.booksOrganizationId)
    ?? asString(metadata.books_organization_id)
    ?? asString(metadata.defaultOrganizationId);
};

const buildModulePath = (moduleName: ZohoBooksModule, recordId?: string): string =>
  recordId ? `/books/v3/${moduleName}/${encodeURIComponent(recordId)}` : `/books/v3/${moduleName}`;

const buildDocumentModulePath = (moduleName: ZohoBooksDocumentModule, recordId?: string): string =>
  recordId ? `/books/v3/${moduleName}/${encodeURIComponent(recordId)}` : `/books/v3/${moduleName}`;

const toPrimitiveString = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return undefined;
};

const extractListItems = (moduleName: ZohoBooksModule, payload: ZohoBooksResponse): Record<string, unknown>[] =>
  asArrayOfRecords(payload[BOOKS_MODULE_KEYS[moduleName].listKey]);

const extractSingleItem = (moduleName: ZohoBooksModule, payload: ZohoBooksResponse): Record<string, unknown> => {
  const config = BOOKS_MODULE_KEYS[moduleName];
  for (const key of config.singularKeys) {
    const direct = asRecord(payload[key]);
    if (direct) {
      return direct;
    }
  }
  const listMatch = extractListItems(moduleName, payload);
  if (listMatch.length > 0) {
    return listMatch[0];
  }
  return payload;
};

const itemMatchesQuery = (item: Record<string, unknown>, query?: string): boolean => {
  const normalized = query?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return JSON.stringify(item).toLowerCase().includes(normalized);
};

export class ZohoBooksClient {
  private readonly httpClient: ZohoHttpClient;

  private readonly tokenService: Pick<ZohoTokenService, 'getValidAccessToken' | 'forceRefresh'>;

  constructor(options: ZohoBooksClientOptions = {}) {
    this.httpClient = options.httpClient ?? zohoHttpClient;
    this.tokenService = options.tokenService ?? zohoTokenService;
  }

  async listOrganizations(input: {
    companyId: string;
    environment?: string;
  }): Promise<ZohoBooksOrganization[]> {
    const environment = input.environment ?? 'prod';
    const payload = await this.requestWithRefresh<ZohoBooksResponse>({
      companyId: input.companyId,
      environment,
      path: '/books/v3/organizations',
      method: 'GET',
    });

    return asArrayOfRecords(payload.organizations).map((organization) => ({
      organizationId:
        asString(organization.organization_id)
        ?? asString(organization.organizationId)
        ?? '',
      name: asString(organization.name),
      isDefault:
        asBoolean(organization.is_default_org)
        ?? asBoolean(organization.is_default)
        ?? asBoolean(organization.isDefault),
      raw: organization,
    })).filter((organization) => organization.organizationId.length > 0);
  }

  async listRecords(input: {
    companyId: string;
    environment?: string;
    moduleName: ZohoBooksModule;
    organizationId?: string;
    filters?: Record<string, unknown>;
    limit?: number;
    query?: string;
  }): Promise<{ organizationId: string; items: Record<string, unknown>[]; payload: ZohoBooksResponse }> {
    const environment = input.environment ?? 'prod';
    const organizationId = await this.resolveOrganizationId({
      companyId: input.companyId,
      environment,
      preferredOrganizationId: input.organizationId,
    });
    const params = new URLSearchParams({
      organization_id: organizationId,
      page: '1',
      per_page: String(Math.max(1, Math.min(200, input.limit ?? 25))),
    });

    for (const [key, value] of Object.entries(input.filters ?? {})) {
      const primitive = toPrimitiveString(value);
      if (primitive) {
        params.set(key, primitive);
      }
    }

    const payload = await this.requestWithRefresh<ZohoBooksResponse>({
      companyId: input.companyId,
      environment,
      path: `${buildModulePath(input.moduleName)}?${params.toString()}`,
      method: 'GET',
    });

    const filtered = extractListItems(input.moduleName, payload)
      .filter((item) => itemMatchesQuery(item, input.query))
      .slice(0, Math.max(1, Math.min(200, input.limit ?? 25)));

    return {
      organizationId,
      items: filtered,
      payload,
    };
  }

  async getRecord(input: {
    companyId: string;
    environment?: string;
    moduleName: ZohoBooksModule;
    recordId: string;
    organizationId?: string;
  }): Promise<{ organizationId: string; record: Record<string, unknown>; payload: ZohoBooksResponse }> {
    const environment = input.environment ?? 'prod';
    const organizationId = await this.resolveOrganizationId({
      companyId: input.companyId,
      environment,
      preferredOrganizationId: input.organizationId,
    });
    const payload = await this.requestWithRefresh<ZohoBooksResponse>({
      companyId: input.companyId,
      environment,
      path: `${buildModulePath(input.moduleName, input.recordId)}?organization_id=${encodeURIComponent(organizationId)}`,
      method: 'GET',
    });

    return {
      organizationId,
      record: extractSingleItem(input.moduleName, payload),
      payload,
    };
  }

  async createRecord(input: {
    companyId: string;
    environment?: string;
    moduleName: ZohoBooksModule;
    organizationId?: string;
    body: Record<string, unknown>;
  }): Promise<{ organizationId: string; record: Record<string, unknown>; payload: ZohoBooksResponse }> {
    const environment = input.environment ?? 'prod';
    const organizationId = await this.resolveOrganizationId({
      companyId: input.companyId,
      environment,
      preferredOrganizationId: input.organizationId,
    });
    const payload = await this.requestWithRefresh<ZohoBooksResponse>({
      companyId: input.companyId,
      environment,
      path: `${buildModulePath(input.moduleName)}?organization_id=${encodeURIComponent(organizationId)}`,
      method: 'POST',
      body: input.body,
    });

    return {
      organizationId,
      record: extractSingleItem(input.moduleName, payload),
      payload,
    };
  }

  async updateRecord(input: {
    companyId: string;
    environment?: string;
    moduleName: ZohoBooksModule;
    recordId: string;
    organizationId?: string;
    body: Record<string, unknown>;
  }): Promise<{ organizationId: string; record: Record<string, unknown>; payload: ZohoBooksResponse }> {
    const environment = input.environment ?? 'prod';
    const organizationId = await this.resolveOrganizationId({
      companyId: input.companyId,
      environment,
      preferredOrganizationId: input.organizationId,
    });
    const payload = await this.requestWithRefresh<ZohoBooksResponse>({
      companyId: input.companyId,
      environment,
      path: `${buildModulePath(input.moduleName, input.recordId)}?organization_id=${encodeURIComponent(organizationId)}`,
      method: 'PUT',
      body: input.body,
    });

    return {
      organizationId,
      record: extractSingleItem(input.moduleName, payload),
      payload,
    };
  }

  async deleteRecord(input: {
    companyId: string;
    environment?: string;
    moduleName: ZohoBooksModule;
    recordId: string;
    organizationId?: string;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'DELETE',
      path: `${buildModulePath(input.moduleName, input.recordId)}`,
    });
  }

  async importBankStatement(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    body: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: '/books/v3/bankstatements',
      body: input.body,
    });
  }

  async getLastImportedBankStatement(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    accountId: string;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'GET',
      path: `/books/v3/bankaccounts/${encodeURIComponent(input.accountId)}/statement/lastimported`,
    });
  }

  async setBankAccountStatus(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    accountId: string;
    active: boolean;
  }): Promise<ZohoBooksScopedResult> {
    const suffix = input.active ? 'active' : 'inactive';
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/bankaccounts/${encodeURIComponent(input.accountId)}/${suffix}`,
    });
  }

  async emailContact(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    contactId: string;
    body: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/contacts/${encodeURIComponent(input.contactId)}/email`,
      body: input.body,
    });
  }

  async setContactPaymentReminderEnabled(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    contactId: string;
    enabled: boolean;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/contacts/${encodeURIComponent(input.contactId)}/paymentreminder/${input.enabled ? 'enable' : 'disable'}`,
    });
  }

  async emailContactStatement(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    contactId: string;
    body: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/contacts/${encodeURIComponent(input.contactId)}/statements/email`,
      body: input.body,
    });
  }

  async getContactStatementEmailContent(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    contactId: string;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'GET',
      path: `/books/v3/contacts/${encodeURIComponent(input.contactId)}/statements/email`,
    });
  }

  async emailVendorPayment(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    vendorPaymentId: string;
    body: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/vendorpayments/${encodeURIComponent(input.vendorPaymentId)}/email`,
      body: input.body,
    });
  }

  async getVendorPaymentEmailContent(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    vendorPaymentId: string;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'GET',
      path: `/books/v3/vendorpayments/${encodeURIComponent(input.vendorPaymentId)}/email`,
    });
  }

  async getMatchingBankTransactions(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    transactionId: string;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'GET',
      path: `/books/v3/banktransactions/uncategorized/${encodeURIComponent(input.transactionId)}/match`,
    });
  }

  async matchBankTransaction(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    transactionId: string;
    body: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/banktransactions/uncategorized/${encodeURIComponent(input.transactionId)}/match`,
      body: input.body,
    });
  }

  async unmatchBankTransaction(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    transactionId: string;
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/banktransactions/${encodeURIComponent(input.transactionId)}/unmatch`,
      body: input.body,
    });
  }

  async excludeBankTransaction(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    transactionId: string;
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/banktransactions/uncategorized/${encodeURIComponent(input.transactionId)}/exclude`,
      body: input.body,
    });
  }

  async restoreBankTransaction(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    transactionId: string;
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/banktransactions/uncategorized/${encodeURIComponent(input.transactionId)}/restore`,
      body: input.body,
    });
  }

  async uncategorizeBankTransaction(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    transactionId: string;
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/banktransactions/${encodeURIComponent(input.transactionId)}/uncategorize`,
      body: input.body,
    });
  }

  async categorizeBankTransaction(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    transactionId: string;
    category: 'general' | 'expense' | 'vendorpayments' | 'customerpayments' | 'creditnoterefunds';
    body: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    const suffix = input.category === 'general'
      ? 'categorize'
      : input.category === 'expense'
        ? 'categorize/expenses'
        : input.category === 'vendorpayments'
          ? 'categorize/vendorpayments'
          : input.category === 'customerpayments'
            ? 'categorize/customerpayments'
            : 'categorize/creditnoterefunds';

    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/banktransactions/uncategorized/${encodeURIComponent(input.transactionId)}/${suffix}`,
      body: input.body,
    });
  }

  async getInvoiceEmailContent(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    invoiceId: string;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'GET',
      path: `/books/v3/invoices/${encodeURIComponent(input.invoiceId)}/email`,
    });
  }

  async writeOffInvoice(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    invoiceId: string;
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/invoices/${encodeURIComponent(input.invoiceId)}/writeoff`,
      body: input.body,
    });
  }

  async cancelInvoiceWriteOff(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    invoiceId: string;
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/invoices/${encodeURIComponent(input.invoiceId)}/writeoff/cancel`,
      body: input.body,
    });
  }

  async emailInvoice(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    invoiceId: string;
    body: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/invoices/${encodeURIComponent(input.invoiceId)}/email`,
      body: input.body,
    });
  }

  async getInvoicePaymentReminderContent(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    invoiceId: string;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'GET',
      path: `/books/v3/invoices/${encodeURIComponent(input.invoiceId)}/paymentreminder`,
    });
  }

  async remindInvoice(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    invoiceId: string;
    body: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/invoices/${encodeURIComponent(input.invoiceId)}/paymentreminder`,
      body: input.body,
    });
  }

  async setInvoicePaymentReminderEnabled(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    invoiceId: string;
    enabled: boolean;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/invoices/${encodeURIComponent(input.invoiceId)}/paymentreminder/${input.enabled ? 'enable' : 'disable'}`,
    });
  }

  async transitionInvoice(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    invoiceId: string;
    action: 'markSent' | 'markVoid' | 'markDraft' | 'submit' | 'approve';
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    const suffix = input.action === 'markSent'
      ? 'status/sent'
      : input.action === 'markVoid'
        ? 'status/void'
        : input.action === 'markDraft'
          ? 'status/draft'
          : input.action;

    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/invoices/${encodeURIComponent(input.invoiceId)}/${suffix}`,
      body: input.body,
    });
  }

  async transitionBill(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    billId: string;
    action: 'markVoid' | 'markOpen' | 'submit' | 'approve';
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    const suffix = input.action === 'markVoid'
      ? 'status/void'
      : input.action === 'markOpen'
        ? 'status/open'
        : input.action;

    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/bills/${encodeURIComponent(input.billId)}/${suffix}`,
      body: input.body,
    });
  }

  async getEstimateEmailContent(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    estimateId: string;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'GET',
      path: `/books/v3/estimates/${encodeURIComponent(input.estimateId)}/email`,
    });
  }

  async emailEstimate(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    estimateId: string;
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/estimates/${encodeURIComponent(input.estimateId)}/email`,
      body: input.body,
    });
  }

  async transitionEstimate(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    estimateId: string;
    action: 'markSent' | 'markAccepted' | 'markDeclined' | 'submit' | 'approve';
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    const suffix = input.action === 'markSent'
      ? 'status/sent'
      : input.action === 'markAccepted'
        ? 'status/accepted'
        : input.action === 'markDeclined'
          ? 'status/declined'
          : input.action;

    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/estimates/${encodeURIComponent(input.estimateId)}/${suffix}`,
      body: input.body,
    });
  }

  async getCreditNoteEmailContent(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    creditNoteId: string;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'GET',
      path: `/books/v3/creditnotes/${encodeURIComponent(input.creditNoteId)}/email`,
    });
  }

  async emailCreditNote(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    creditNoteId: string;
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/creditnotes/${encodeURIComponent(input.creditNoteId)}/email`,
      body: input.body,
    });
  }

  async transitionCreditNote(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    creditNoteId: string;
    action: 'markOpen' | 'markVoid';
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    const suffix = input.action === 'markOpen' ? 'status/open' : 'status/void';
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/creditnotes/${encodeURIComponent(input.creditNoteId)}/${suffix}`,
      body: input.body,
    });
  }

  async refundCreditNote(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    creditNoteId: string;
    body: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/creditnotes/${encodeURIComponent(input.creditNoteId)}/refunds`,
      body: input.body,
    });
  }

  async getSalesOrderEmailContent(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    salesOrderId: string;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'GET',
      path: `/books/v3/salesorders/${encodeURIComponent(input.salesOrderId)}/email`,
    });
  }

  async emailSalesOrder(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    salesOrderId: string;
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/salesorders/${encodeURIComponent(input.salesOrderId)}/email`,
      body: input.body,
    });
  }

  async transitionSalesOrder(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    salesOrderId: string;
    action: 'markOpen' | 'markVoid' | 'submit' | 'approve';
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    const suffix = input.action === 'markOpen'
      ? 'status/open'
      : input.action === 'markVoid'
        ? 'status/void'
        : input.action;
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/salesorders/${encodeURIComponent(input.salesOrderId)}/${suffix}`,
      body: input.body,
    });
  }

  async createInvoiceFromSalesOrder(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    salesOrderId: string;
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/salesorders/${encodeURIComponent(input.salesOrderId)}/invoice`,
      body: input.body,
    });
  }

  async getPurchaseOrderEmailContent(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    purchaseOrderId: string;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'GET',
      path: `/books/v3/purchaseorders/${encodeURIComponent(input.purchaseOrderId)}/email`,
    });
  }

  async listTemplates(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    moduleName: ZohoBooksDocumentModule;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'GET',
      path: `${buildDocumentModulePath(input.moduleName)}/templates`,
    });
  }

  async applyTemplate(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    moduleName: ZohoBooksDocumentModule;
    recordId: string;
    templateId: string;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'PUT',
      path: `${buildDocumentModulePath(input.moduleName, input.recordId)}/templates/${encodeURIComponent(input.templateId)}`,
    });
  }

  async getAttachment(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    moduleName: ZohoBooksDocumentModule;
    recordId: string;
  }): Promise<ZohoBooksRawScopedResult> {
    return this.requestRawInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'GET',
      path: `${buildDocumentModulePath(input.moduleName, input.recordId)}/attachment`,
    });
  }

  async uploadAttachment(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    moduleName: ZohoBooksDocumentModule;
    recordId: string;
    fileName: string;
    contentBase64: string;
    contentType?: string;
  }): Promise<ZohoBooksScopedResult> {
    const fileBytes = Uint8Array.from(Buffer.from(input.contentBase64, 'base64'));
    const formData = new FormData();
    formData.append(
      'attachment',
      new Blob([fileBytes], { type: input.contentType ?? 'application/octet-stream' }),
      input.fileName,
    );
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `${buildDocumentModulePath(input.moduleName, input.recordId)}/attachment`,
      body: formData,
    });
  }

  async deleteAttachment(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    moduleName: ZohoBooksDocumentModule;
    recordId: string;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'DELETE',
      path: `${buildDocumentModulePath(input.moduleName, input.recordId)}/attachment`,
    });
  }

  async getRecordDocument(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    moduleName: ZohoBooksDocumentModule;
    recordId: string;
    accept?: 'pdf' | 'html';
  }): Promise<ZohoBooksRawScopedResult> {
    const params = new URLSearchParams();
    if (input.accept) {
      params.set('accept', input.accept);
    }
    const suffix = params.toString();
    return this.requestRawInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'GET',
      path: `${buildDocumentModulePath(input.moduleName, input.recordId)}${suffix ? `?${suffix}` : ''}`,
    });
  }

  async emailPurchaseOrder(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    purchaseOrderId: string;
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/purchaseorders/${encodeURIComponent(input.purchaseOrderId)}/email`,
      body: input.body,
    });
  }

  async transitionPurchaseOrder(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    purchaseOrderId: string;
    action: 'markOpen' | 'markBilled' | 'markCancelled' | 'reject' | 'submit' | 'approve';
    body?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    const suffix = input.action === 'markOpen'
      ? 'status/open'
      : input.action === 'markBilled'
        ? 'status/billed'
        : input.action === 'markCancelled'
          ? 'status/cancelled'
          : input.action;
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `/books/v3/purchaseorders/${encodeURIComponent(input.purchaseOrderId)}/${suffix}`,
      body: input.body,
    });
  }

  async listComments(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    moduleName: ZohoBooksCommentModule;
    recordId: string;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'GET',
      path: `${buildModulePath(input.moduleName, input.recordId)}/comments`,
    });
  }

  async addComment(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    moduleName: ZohoBooksCommentModule;
    recordId: string;
    body: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'POST',
      path: `${buildModulePath(input.moduleName, input.recordId)}/comments`,
      body: input.body,
    });
  }

  async updateComment(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    moduleName: ZohoBooksCommentModule;
    recordId: string;
    commentId: string;
    body: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'PUT',
      path: `${buildModulePath(input.moduleName, input.recordId)}/comments/${encodeURIComponent(input.commentId)}`,
      body: input.body,
    });
  }

  async deleteComment(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    moduleName: ZohoBooksCommentModule;
    recordId: string;
    commentId: string;
  }): Promise<ZohoBooksScopedResult> {
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'DELETE',
      path: `${buildModulePath(input.moduleName, input.recordId)}/comments/${encodeURIComponent(input.commentId)}`,
    });
  }

  async getReport(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    reportName: string;
    filters?: Record<string, unknown>;
  }): Promise<ZohoBooksScopedResult> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input.filters ?? {})) {
      const primitive = toPrimitiveString(value);
      if (primitive) {
        params.set(key, primitive);
      }
    }
    const suffix = params.toString();
    return this.requestInOrganizationScope({
      companyId: input.companyId,
      environment: input.environment,
      organizationId: input.organizationId,
      method: 'GET',
      path: `/books/v3/reports/${encodeURIComponent(input.reportName)}${suffix ? `?${suffix}` : ''}`,
    });
  }

  private async resolveOrganizationId(input: {
    companyId: string;
    environment: string;
    preferredOrganizationId?: string;
  }): Promise<string> {
    const connection = await prisma.zohoConnection.findUnique({
      where: {
        companyId_environment: {
          companyId: input.companyId,
          environment: input.environment,
        },
      },
    });

    const metadata = tokenMetadataToRecord(connection?.tokenMetadata);
    const preferred = asString(input.preferredOrganizationId);
    const fromMetadata = readOrganizationIdFromMetadata(metadata);

    const organizations = await this.listOrganizations({
      companyId: input.companyId,
      environment: input.environment,
    });
    const accessibleOrganizationIds = new Set(organizations.map((organization) => organization.organizationId));

    if (preferred && accessibleOrganizationIds.has(preferred)) {
      return preferred;
    }

    if (fromMetadata && accessibleOrganizationIds.has(fromMetadata)) {
      return fromMetadata;
    }

    const defaultOrg = organizations.find((organization) => organization.isDefault);
    const resolved = defaultOrg?.organizationId
      ?? (organizations.length === 1 ? organizations[0]?.organizationId : undefined);

    if (!resolved) {
      throw new ZohoIntegrationError({
        message: 'Zoho Books organization is not configured. Connect a default Books organization or store organizationId in the Zoho connection metadata.',
        code: 'schema_mismatch',
        retriable: false,
      });
    }

    if (preferred && preferred !== resolved) {
      logger.warn('zoho.books.organization.fallback_from_preferred', {
        companyId: input.companyId,
        environment: input.environment,
        preferredOrganizationId: preferred,
        resolvedOrganizationId: resolved,
      });
    } else if (fromMetadata && fromMetadata !== resolved) {
      logger.warn('zoho.books.organization.fallback_from_metadata', {
        companyId: input.companyId,
        environment: input.environment,
        metadataOrganizationId: fromMetadata,
        resolvedOrganizationId: resolved,
      });
    }

    if (connection) {
      await prisma.zohoConnection.update({
        where: { id: connection.id },
        data: {
          tokenMetadata: {
            ...(metadata ?? {}),
            organizationId: resolved,
          },
        },
      });
    }

    return resolved;
  }

  private async requestWithRefresh<T>(input: {
    companyId: string;
    environment: string;
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: Record<string, unknown> | FormData;
  }): Promise<T> {
    const token = await this.tokenService.getValidAccessToken(input.companyId, input.environment);
    try {
      return await this.httpClient.requestJson<T>({
        base: 'api',
        path: input.path,
        method: input.method,
        body: input.body,
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
        },
      });
    } catch (error) {
      const isAuthError = error instanceof ZohoIntegrationError && error.code === 'auth_failed';
      if (!isAuthError) {
        throw error;
      }

      const refreshedToken = await this.tokenService.forceRefresh(input.companyId, input.environment);
      return this.httpClient.requestJson<T>({
        base: 'api',
        path: input.path,
        method: input.method,
        body: input.body,
        headers: {
          Authorization: `Zoho-oauthtoken ${refreshedToken}`,
        },
        retry: {
          maxAttempts: 1,
          baseDelayMs: 0,
        },
      });
    }
  }

  private async requestRawWithRefresh(input: {
    companyId: string;
    environment: string;
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: Record<string, unknown> | FormData;
  }): Promise<ZohoRawResponse> {
    const token = await this.tokenService.getValidAccessToken(input.companyId, input.environment);
    try {
      return await this.httpClient.requestRaw({
        base: 'api',
        path: input.path,
        method: input.method,
        body: input.body,
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
        },
      });
    } catch (error) {
      const isAuthError = error instanceof ZohoIntegrationError && error.code === 'auth_failed';
      if (!isAuthError) {
        throw error;
      }

      const refreshedToken = await this.tokenService.forceRefresh(input.companyId, input.environment);
      return this.httpClient.requestRaw({
        base: 'api',
        path: input.path,
        method: input.method,
        body: input.body,
        headers: {
          Authorization: `Zoho-oauthtoken ${refreshedToken}`,
        },
        retry: {
          maxAttempts: 1,
          baseDelayMs: 0,
        },
      });
    }
  }

  private async requestInOrganizationScope(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: Record<string, unknown> | FormData;
  }): Promise<ZohoBooksScopedResult> {
    const environment = input.environment ?? 'prod';
    const organizationId = await this.resolveOrganizationId({
      companyId: input.companyId,
      environment,
      preferredOrganizationId: input.organizationId,
    });
    const separator = input.path.includes('?') ? '&' : '?';
    const payload = await this.requestWithRefresh<ZohoBooksResponse>({
      companyId: input.companyId,
      environment,
      path: `${input.path}${separator}organization_id=${encodeURIComponent(organizationId)}`,
      method: input.method,
      body: input.body,
    });

    return {
      organizationId,
      payload,
    };
  }

  private async requestRawInOrganizationScope(input: {
    companyId: string;
    environment?: string;
    organizationId?: string;
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: Record<string, unknown> | FormData;
  }): Promise<ZohoBooksRawScopedResult> {
    const environment = input.environment ?? 'prod';
    const organizationId = await this.resolveOrganizationId({
      companyId: input.companyId,
      environment,
      preferredOrganizationId: input.organizationId,
    });
    const separator = input.path.includes('?') ? '&' : '?';
    const payload = await this.requestRawWithRefresh({
      companyId: input.companyId,
      environment,
      path: `${input.path}${separator}organization_id=${encodeURIComponent(organizationId)}`,
      method: input.method,
      body: input.body,
    });

    return {
      organizationId,
      payload,
    };
  }
}

export const zohoBooksClient = new ZohoBooksClient();
