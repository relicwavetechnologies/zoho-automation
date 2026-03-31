import { formatZohoGatewayDeniedMessage } from './zoho-gateway-denials';
import { zohoGatewayService } from './zoho-gateway.service';

type StatementRow = {
  rowId?: string;
  date?: string;
  description?: string;
  reference?: string;
  amount?: number;
  debit?: number;
  credit?: number;
  balance?: number;
  invoiceNumber?: string;
  vendorName?: string;
  customerName?: string;
};

type MatchCandidate = {
  score: number;
  reasons: string[];
};

const asString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const normalizeText = (value?: string): string =>
  (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const parseDate = (value?: string): Date | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const hasMoreBooksPage = (payload?: Record<string, unknown>): boolean =>
  asBoolean(asRecord(payload?.page_context)?.has_more_page) ?? false;

const isWithinDateRange = (value: Date | undefined, from?: Date, to?: Date): boolean => {
  if (!from && !to) {
    return true;
  }
  if (!value) {
    return false;
  }
  if (from && value.getTime() < from.getTime()) {
    return false;
  }
  if (to && value.getTime() > to.getTime()) {
    return false;
  }
  return true;
};

const diffInDays = (left?: Date, right?: Date): number | undefined => {
  if (!left || !right) return undefined;
  return Math.round((left.getTime() - right.getTime()) / 86_400_000);
};

const absoluteAmountDifference = (left?: number, right?: number): number | undefined => {
  if (left === undefined || right === undefined) return undefined;
  return Math.abs(left - right);
};

const readInvoiceNumber = (record: Record<string, unknown>): string | undefined =>
  asString(record.invoice_number) ?? asString(record.invoiceNumber);

const readInvoiceId = (record: Record<string, unknown>): string | undefined =>
  asString(record.invoice_id) ?? asString(record.id);

const readCustomerId = (record: Record<string, unknown>): string | undefined =>
  asString(record.customer_id) ?? asString(record.contact_id) ?? asString(record.customerId);

const readCustomerName = (record: Record<string, unknown>): string | undefined =>
  asString(record.customer_name) ?? asString(record.contact_name) ?? asString(record.customerName);

const readVendorId = (record: Record<string, unknown>): string | undefined =>
  asString(record.vendor_id) ?? asString(record.contact_id) ?? asString(record.vendorId);

const readVendorName = (record: Record<string, unknown>): string | undefined =>
  asString(record.vendor_name) ?? asString(record.contact_name) ?? asString(record.vendorName);

const readTransactionDate = (record: Record<string, unknown>): string | undefined =>
  asString(record.date) ?? asString(record.payment_date) ?? asString(record.transaction_date) ?? asString(record.created_time);

const readBalance = (record: Record<string, unknown>): number =>
  asNumber(record.balance)
  ?? asNumber(record.amount_due)
  ?? asNumber(record.outstanding_balance)
  ?? 0;

const readAmount = (record: Record<string, unknown>): number =>
  asNumber(record.total)
  ?? asNumber(record.amount)
  ?? asNumber(record.payment_amount)
  ?? asNumber(record.amount_applied)
  ?? 0;

const readReference = (record: Record<string, unknown>): string | undefined =>
  asString(record.reference_number)
  ?? asString(record.reference)
  ?? asString(record.payment_number)
  ?? asString(record.transaction_number);

const readBankTransactionId = (record: Record<string, unknown>): string | undefined =>
  asString(record.bank_transaction_id) ?? asString(record.transaction_id) ?? asString(record.id);

const buildReferenceTokens = (...values: Array<string | undefined>): Set<string> => {
  const tokens = new Set<string>();
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    for (const token of normalized.split(' ')) {
      if (token.length >= 4) {
        tokens.add(token);
      }
    }
  }
  return tokens;
};

const scoreNameOverlap = (left?: string, right?: string): number => {
  const leftTokens = new Set(normalizeText(left).split(' ').filter((token) => token.length >= 3));
  const rightTokens = new Set(normalizeText(right).split(' ').filter((token) => token.length >= 3));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
};

const scorePaymentToInvoice = (
  payment: Record<string, unknown>,
  invoice: Record<string, unknown>,
  amountTolerance: number,
  dateToleranceDays: number,
): MatchCandidate => {
  let score = 0;
  const reasons: string[] = [];

  const paymentCustomerId = readCustomerId(payment);
  const invoiceCustomerId = readCustomerId(invoice);
  if (paymentCustomerId && invoiceCustomerId && paymentCustomerId === invoiceCustomerId) {
    score += 0.45;
    reasons.push('customer_id_match');
  }

  const paymentName = readCustomerName(payment);
  const invoiceName = readCustomerName(invoice);
  const nameScore = scoreNameOverlap(paymentName, invoiceName);
  if (nameScore >= 0.6) {
    score += 0.2;
    reasons.push('customer_name_match');
  }

  const paymentAmount = readAmount(payment);
  const invoiceBalance = readBalance(invoice);
  const amountDiff = absoluteAmountDifference(paymentAmount, invoiceBalance);
  if (amountDiff !== undefined && amountDiff <= amountTolerance) {
    score += 0.25;
    reasons.push('amount_match');
  } else if (amountDiff !== undefined && amountDiff <= amountTolerance * 5) {
    score += 0.1;
    reasons.push('amount_near_match');
  }

  const paymentDate = parseDate(readTransactionDate(payment));
  const invoiceDueDate = parseDate(asString(invoice.due_date));
  const invoiceDate = parseDate(asString(invoice.date));
  const nearestInvoiceDate = invoiceDueDate ?? invoiceDate;
  const dateDiff = diffInDays(paymentDate, nearestInvoiceDate);
  if (dateDiff !== undefined && Math.abs(dateDiff) <= dateToleranceDays) {
    score += 0.1;
    reasons.push('date_window_match');
  }

  const paymentRefs = buildReferenceTokens(
    readReference(payment),
    asString(payment.invoice_number),
    asString(payment.description),
  );
  const invoiceRefs = buildReferenceTokens(
    readInvoiceNumber(invoice),
    readReference(invoice),
  );
  for (const token of paymentRefs) {
    if (invoiceRefs.has(token)) {
      score += 0.2;
      reasons.push('reference_match');
      break;
    }
  }

  return {
    score: Math.min(1, score),
    reasons,
  };
};

const scoreStatementRowToRecord = (
  row: StatementRow,
  record: Record<string, unknown>,
  input: {
    amountTolerance: number;
    dateToleranceDays: number;
    partyName?: string;
    invoiceNumber?: string;
  },
): MatchCandidate => {
  let score = 0;
  const reasons: string[] = [];
  const rowAmount = row.amount ?? row.credit ?? row.debit;
  const recordAmount = readAmount(record);
  const amountDiff = absoluteAmountDifference(rowAmount, recordAmount);
  if (amountDiff !== undefined && amountDiff <= input.amountTolerance) {
    score += 0.4;
    reasons.push('amount_match');
  } else if (amountDiff !== undefined && amountDiff <= input.amountTolerance * 5) {
    score += 0.15;
    reasons.push('amount_near_match');
  }

  const rowDate = parseDate(row.date);
  const recordDate = parseDate(readTransactionDate(record) ?? asString(record.due_date));
  const dateDiff = diffInDays(rowDate, recordDate);
  if (dateDiff !== undefined && Math.abs(dateDiff) <= input.dateToleranceDays) {
    score += 0.2;
    reasons.push('date_window_match');
  }

  const partyScore = scoreNameOverlap(
    input.partyName ?? row.vendorName ?? row.customerName ?? row.description,
    readVendorName(record) ?? readCustomerName(record) ?? asString(record.account_name),
  );
  if (partyScore >= 0.6) {
    score += 0.2;
    reasons.push('party_match');
  }

  const rowRefs = buildReferenceTokens(row.reference, row.invoiceNumber, row.description);
  const recordRefs = buildReferenceTokens(
    readReference(record),
    readInvoiceNumber(record),
    input.invoiceNumber,
  );
  for (const token of rowRefs) {
    if (recordRefs.has(token)) {
      score += 0.2;
      reasons.push('reference_match');
      break;
    }
  }

  return {
    score: Math.min(1, score),
    reasons,
  };
};

export class ZohoFinanceOpsService {
  private async listCompanyScopedBooksRecords(input: {
    companyId: string;
    organizationId?: string;
    requesterEmail?: string;
    requesterAiRole?: string;
    departmentZohoReadScope?: 'personalized' | 'show_all';
    module: 'invoices' | 'customerpayments' | 'banktransactions' | 'bills' | 'vendorpayments';
    filters?: Record<string, unknown>;
    query?: string;
    limit?: number;
    page?: number;
    perPage?: number;
  }): Promise<{
    organizationId?: string;
    records: Record<string, unknown>[];
    raw?: Record<string, unknown>;
    scopeMode?: 'self_scoped' | 'company_scoped';
  }> {
    const auth = await zohoGatewayService.listAuthorizedRecords({
      domain: 'books',
      module: input.module,
      requester: {
        companyId: input.companyId,
        requesterEmail: input.requesterEmail,
        requesterAiRole: input.requesterAiRole,
        departmentZohoReadScope: input.departmentZohoReadScope,
      },
      organizationId: input.organizationId,
      filters: input.filters,
      query: input.query,
      limit: input.limit,
      page: input.page,
      perPage: input.perPage,
    });

    if (!auth.allowed) {
      throw new Error(formatZohoGatewayDeniedMessage(auth, `You are not allowed to read Zoho Books ${input.module}.`).summary);
    }

    return {
      organizationId: auth.organizationId,
      records: Array.isArray(auth.payload?.records) ? auth.payload.records : [],
      raw: auth.payload?.raw,
      scopeMode: auth.scopeMode,
    };
  }

  async buildOverdueReport(input: {
    companyId: string;
    organizationId?: string;
    requesterEmail?: string;
    requesterAiRole?: string;
    departmentZohoReadScope?: 'personalized' | 'show_all';
    asOfDate?: string;
    limit?: number;
    minOverdueDays?: number;
    invoiceDateFrom?: string;
    invoiceDateTo?: string;
  }) {
    const asOfDate = parseDate(input.asOfDate) ?? new Date();
    const limit = Math.max(1, Math.min(200, input.limit ?? 100));
    const minOverdueDays = Math.max(0, input.minOverdueDays ?? 1);
    const invoiceDateFrom = parseDate(input.invoiceDateFrom);
    const invoiceDateTo = parseDate(input.invoiceDateTo);
    const pageSize = 200;
    const maxPages = 20;
    const scannedRecords: Record<string, unknown>[] = [];
    const seenInvoiceIds = new Set<string>();
    let organizationId = input.organizationId;
    let scopeMode: 'self_scoped' | 'company_scoped' | undefined;
    let sourceTruncated = false;

    for (let page = 1; page <= maxPages; page += 1) {
      const result = await this.listCompanyScopedBooksRecords({
        companyId: input.companyId,
        organizationId,
        requesterEmail: input.requesterEmail,
        requesterAiRole: input.requesterAiRole,
        departmentZohoReadScope: input.departmentZohoReadScope,
        module: 'invoices',
        limit: pageSize,
        page,
        perPage: pageSize,
        filters: {
          status: 'overdue',
        },
      });
      organizationId = result.organizationId ?? organizationId;
      scopeMode = result.scopeMode ?? scopeMode;
      for (const record of result.records) {
        const invoiceId = readInvoiceId(record) ?? JSON.stringify(record);
        if (seenInvoiceIds.has(invoiceId)) {
          continue;
        }
        seenInvoiceIds.add(invoiceId);
        scannedRecords.push(record);
      }
      if (!hasMoreBooksPage(result.raw)) {
        break;
      }
      if (page === maxPages) {
        sourceTruncated = true;
      }
    }

    const matchedInvoices = scannedRecords
      .map((invoice) => {
        const dueDate = parseDate(asString(invoice.due_date));
        const invoiceDate = parseDate(asString(invoice.date));
        const overdueDays = diffInDays(asOfDate, dueDate) ?? 0;
        const balance = readBalance(invoice);
        return {
          invoiceId: readInvoiceId(invoice),
          invoiceNumber: readInvoiceNumber(invoice),
          customerId: readCustomerId(invoice),
          customerName: readCustomerName(invoice),
          status: asString(invoice.status) ?? 'unknown',
          dueDate: asString(invoice.due_date),
          invoiceDate: asString(invoice.date),
          total: readAmount(invoice),
          balance,
          overdueDays,
          invoiceDateMatch: isWithinDateRange(invoiceDate, invoiceDateFrom, invoiceDateTo),
        };
      })
      .filter((invoice) =>
        invoice.balance > 0
        && invoice.overdueDays >= minOverdueDays
        && invoice.invoiceDateMatch,
      )
      .map(({ invoiceDateMatch: _invoiceDateMatch, ...invoice }) => invoice)
      .sort((left, right) => right.overdueDays - left.overdueDays);

    const visibleInvoices = matchedInvoices.slice(0, limit);

    const bucketTotals = {
      current: 0,
      days_1_30: 0,
      days_31_60: 0,
      days_61_90: 0,
      days_91_plus: 0,
    };
    const customerTotals = new Map<string, { customerId?: string; customerName?: string; balance: number; invoiceCount: number }>();

    for (const invoice of matchedInvoices) {
      if (invoice.overdueDays <= 0) bucketTotals.current += invoice.balance;
      else if (invoice.overdueDays <= 30) bucketTotals.days_1_30 += invoice.balance;
      else if (invoice.overdueDays <= 60) bucketTotals.days_31_60 += invoice.balance;
      else if (invoice.overdueDays <= 90) bucketTotals.days_61_90 += invoice.balance;
      else bucketTotals.days_91_plus += invoice.balance;

      const key = invoice.customerId ?? invoice.customerName ?? invoice.invoiceId ?? 'unknown';
      const existing = customerTotals.get(key) ?? {
        customerId: invoice.customerId,
        customerName: invoice.customerName,
        balance: 0,
        invoiceCount: 0,
      };
      existing.balance += invoice.balance;
      existing.invoiceCount += 1;
      customerTotals.set(key, existing);
    }

    const topCustomers = [...customerTotals.values()]
      .sort((left, right) => right.balance - left.balance)
      .slice(0, 10);

    const totalOutstanding = matchedInvoices.reduce((sum, invoice) => sum + invoice.balance, 0);
    const limitedResults = visibleInvoices.length < matchedInvoices.length;
    let summary = matchedInvoices.length > 0
      ? `Found ${matchedInvoices.length} overdue invoice(s) totaling ${totalOutstanding.toFixed(2)}.`
      : 'No overdue invoices matched the current criteria.';
    if (limitedResults) {
      summary += ` Showing first ${visibleInvoices.length}.`;
    }
    if (sourceTruncated) {
      summary += ' Additional overdue invoices may exist beyond the pagination scan limit.';
    }
    if (scopeMode === 'self_scoped') {
      summary += ' Results are limited to the requester-accessible Zoho Books customers.';
    }

    return {
      summary,
      asOfDate: asOfDate.toISOString(),
      organizationId,
      scopeMode,
      invoiceCount: matchedInvoices.length,
      displayedInvoiceCount: visibleInvoices.length,
      totalOutstanding,
      bucketTotals,
      topCustomers,
      sourceTruncated,
      appliedFilters: {
        minOverdueDays,
        invoiceDateFrom: input.invoiceDateFrom,
        invoiceDateTo: input.invoiceDateTo,
      },
      invoices: visibleInvoices,
    };
  }

  async mapCustomerPayments(input: {
    companyId: string;
    organizationId?: string;
    requesterEmail?: string;
    requesterAiRole?: string;
    departmentZohoReadScope?: 'personalized' | 'show_all';
    customerId?: string;
    amountTolerance?: number;
    dateToleranceDays?: number;
    limit?: number;
  }) {
    const amountTolerance = Math.max(0.01, input.amountTolerance ?? 2);
    const dateToleranceDays = Math.max(1, input.dateToleranceDays ?? 45);
    const limit = Math.max(1, Math.min(200, input.limit ?? 100));

    const [paymentsResult, invoicesResult] = await Promise.all([
      this.listCompanyScopedBooksRecords({
        companyId: input.companyId,
        organizationId: input.organizationId,
        requesterEmail: input.requesterEmail,
        requesterAiRole: input.requesterAiRole,
        departmentZohoReadScope: input.departmentZohoReadScope,
        module: 'customerpayments',
        limit,
        filters: input.customerId ? { customer_id: input.customerId } : undefined,
      }),
      this.listCompanyScopedBooksRecords({
        companyId: input.companyId,
        organizationId: input.organizationId,
        requesterEmail: input.requesterEmail,
        requesterAiRole: input.requesterAiRole,
        departmentZohoReadScope: input.departmentZohoReadScope,
        module: 'invoices',
        limit,
        filters: input.customerId ? { customer_id: input.customerId } : undefined,
      }),
    ]);

    const openInvoices = invoicesResult.records.filter((invoice) => readBalance(invoice) > 0);
    const usedInvoiceIds = new Set<string>();
    const exactMatches: Array<Record<string, unknown>> = [];
    const probableMatches: Array<Record<string, unknown>> = [];
    const unmatchedPayments: Array<Record<string, unknown>> = [];

    for (const payment of paymentsResult.records) {
      const paymentId = asString(payment.payment_id) ?? asString(payment.id);
      const ranked = openInvoices
        .filter((invoice) => {
          const invoiceId = asString(invoice.invoice_id) ?? asString(invoice.id);
          return invoiceId ? !usedInvoiceIds.has(invoiceId) : true;
        })
        .map((invoice) => ({
          invoice,
          candidate: scorePaymentToInvoice(payment, invoice, amountTolerance, dateToleranceDays),
        }))
        .filter((entry) => entry.candidate.score >= 0.4)
        .sort((left, right) => right.candidate.score - left.candidate.score);

      const best = ranked[0];
      if (!best) {
        unmatchedPayments.push({
          paymentId,
          customerId: readCustomerId(payment),
          customerName: readCustomerName(payment),
          amount: readAmount(payment),
          paymentDate: readTransactionDate(payment),
          reference: readReference(payment),
        });
        continue;
      }

      const invoiceId = asString(best.invoice.invoice_id) ?? asString(best.invoice.id);
      if (invoiceId) {
        usedInvoiceIds.add(invoiceId);
      }

      const payload = {
        paymentId,
        invoiceId,
        invoiceNumber: readInvoiceNumber(best.invoice),
        customerId: readCustomerId(best.invoice),
        customerName: readCustomerName(best.invoice),
        paymentAmount: readAmount(payment),
        invoiceBalance: readBalance(best.invoice),
        score: Number(best.candidate.score.toFixed(2)),
        reasons: best.candidate.reasons,
      };
      if (best.candidate.score >= 0.8) {
        exactMatches.push(payload);
      } else {
        probableMatches.push(payload);
      }
    }

    const unmatchedInvoices = openInvoices
      .filter((invoice) => {
        const invoiceId = asString(invoice.invoice_id) ?? asString(invoice.id);
        return invoiceId ? !usedInvoiceIds.has(invoiceId) : true;
      })
      .map((invoice) => ({
        invoiceId: asString(invoice.invoice_id) ?? asString(invoice.id),
        invoiceNumber: readInvoiceNumber(invoice),
        customerId: readCustomerId(invoice),
        customerName: readCustomerName(invoice),
        balance: readBalance(invoice),
        dueDate: asString(invoice.due_date),
      }));

    return {
      summary: `Mapped ${exactMatches.length} exact and ${probableMatches.length} probable customer payment(s).`,
      organizationId: paymentsResult.organizationId,
      exactMatches,
      probableMatches,
      unmatchedPayments,
      unmatchedInvoices,
    };
  }

  async reconcileBankClosing(input: {
    companyId: string;
    organizationId?: string;
    requesterEmail?: string;
    requesterAiRole?: string;
    departmentZohoReadScope?: 'personalized' | 'show_all';
    accountId?: string;
    statementRows: StatementRow[];
    amountTolerance?: number;
    dateToleranceDays?: number;
    limit?: number;
  }) {
    const amountTolerance = Math.max(0.01, input.amountTolerance ?? 1);
    const dateToleranceDays = Math.max(1, input.dateToleranceDays ?? 3);
    const limit = Math.max(1, Math.min(200, input.limit ?? Math.max(50, input.statementRows.length * 2)));
    const result = await this.listCompanyScopedBooksRecords({
      companyId: input.companyId,
      organizationId: input.organizationId,
      requesterEmail: input.requesterEmail,
      requesterAiRole: input.requesterAiRole,
      departmentZohoReadScope: input.departmentZohoReadScope,
      module: 'banktransactions',
      limit,
      filters: input.accountId ? { account_id: input.accountId } : undefined,
    });

    const unmatchedTransactions = new Map<string, Record<string, unknown>>();
    for (const transaction of result.records) {
      const id = readBankTransactionId(transaction);
      if (id) {
        unmatchedTransactions.set(id, transaction);
      }
    }

    const matched: Array<Record<string, unknown>> = [];
    const probableMatches: Array<Record<string, unknown>> = [];
    const unmatchedStatementRows: StatementRow[] = [];

    for (const row of input.statementRows) {
      const ranked = [...unmatchedTransactions.values()]
        .map((transaction) => ({
          transaction,
          candidate: scoreStatementRowToRecord(row, transaction, {
            amountTolerance,
            dateToleranceDays,
          }),
        }))
        .filter((entry) => entry.candidate.score >= 0.45)
        .sort((left, right) => right.candidate.score - left.candidate.score);

      const best = ranked[0];
      if (!best) {
        unmatchedStatementRows.push(row);
        continue;
      }

      const transactionId = readBankTransactionId(best.transaction);
      if (transactionId) {
        unmatchedTransactions.delete(transactionId);
      }

      const payload = {
        rowId: row.rowId,
        transactionId,
        statementAmount: row.amount ?? row.credit ?? row.debit,
        booksAmount: readAmount(best.transaction),
        statementDate: row.date,
        booksDate: readTransactionDate(best.transaction),
        score: Number(best.candidate.score.toFixed(2)),
        reasons: best.candidate.reasons,
        reference: row.reference ?? readReference(best.transaction),
      };
      if (best.candidate.score >= 0.8) {
        matched.push(payload);
      } else {
        probableMatches.push(payload);
      }
    }

    const unmatchedBankTransactions = [...unmatchedTransactions.values()].map((transaction) => ({
      transactionId: readBankTransactionId(transaction),
      date: readTransactionDate(transaction),
      amount: readAmount(transaction),
      reference: readReference(transaction),
      description: asString(transaction.description),
    }));

    return {
      summary: `Bank closing reconciliation produced ${matched.length} exact and ${probableMatches.length} probable match(es).`,
      organizationId: result.organizationId,
      matched,
      probableMatches,
      unmatchedStatementRows,
      unmatchedBankTransactions,
    };
  }

  async reconcileVendorStatement(input: {
    companyId: string;
    organizationId?: string;
    requesterEmail?: string;
    requesterAiRole?: string;
    departmentZohoReadScope?: 'personalized' | 'show_all';
    statementRows: StatementRow[];
    vendorId?: string;
    vendorName?: string;
    amountTolerance?: number;
    dateToleranceDays?: number;
    limit?: number;
  }) {
    const amountTolerance = Math.max(0.01, input.amountTolerance ?? 2);
    const dateToleranceDays = Math.max(1, input.dateToleranceDays ?? 15);
    const limit = Math.max(1, Math.min(200, input.limit ?? Math.max(50, input.statementRows.length * 2)));

    const [billsResult, vendorPaymentsResult] = await Promise.all([
      this.listCompanyScopedBooksRecords({
        companyId: input.companyId,
        organizationId: input.organizationId,
        requesterEmail: input.requesterEmail,
        requesterAiRole: input.requesterAiRole,
        departmentZohoReadScope: input.departmentZohoReadScope,
        module: 'bills',
        limit,
        filters: input.vendorId ? { vendor_id: input.vendorId } : undefined,
      }),
      this.listCompanyScopedBooksRecords({
        companyId: input.companyId,
        organizationId: input.organizationId,
        requesterEmail: input.requesterEmail,
        requesterAiRole: input.requesterAiRole,
        departmentZohoReadScope: input.departmentZohoReadScope,
        module: 'vendorpayments',
        limit,
        filters: input.vendorId ? { vendor_id: input.vendorId } : undefined,
      }),
    ]);

    const availableBills = new Map<string, Record<string, unknown>>();
    for (const bill of billsResult.records) {
      const id = asString(bill.bill_id) ?? asString(bill.id);
      if (id) availableBills.set(id, bill);
    }
    const availablePayments = new Map<string, Record<string, unknown>>();
    for (const payment of vendorPaymentsResult.records) {
      const id = asString(payment.vendor_payment_id) ?? asString(payment.id);
      if (id) availablePayments.set(id, payment);
    }

    const matchedBills: Array<Record<string, unknown>> = [];
    const probableMatches: Array<Record<string, unknown>> = [];
    const unmatchedRows: StatementRow[] = [];

    for (const row of input.statementRows) {
      const candidates = [
        ...[...availableBills.values()].map((record) => ({ kind: 'bill', record })),
        ...[...availablePayments.values()].map((record) => ({ kind: 'vendor_payment', record })),
      ]
        .map((entry) => ({
          ...entry,
          candidate: scoreStatementRowToRecord(row, entry.record, {
            amountTolerance,
            dateToleranceDays,
            partyName: input.vendorName ?? row.vendorName,
            invoiceNumber: row.invoiceNumber,
          }),
        }))
        .filter((entry) => entry.candidate.score >= 0.45)
        .sort((left, right) => right.candidate.score - left.candidate.score);

      const best = candidates[0];
      if (!best) {
        unmatchedRows.push(row);
        continue;
      }

      const recordId = asString(best.record.bill_id)
        ?? asString(best.record.vendor_payment_id)
        ?? asString(best.record.id);

      if (best.kind === 'bill' && recordId) {
        availableBills.delete(recordId);
      }
      if (best.kind === 'vendor_payment' && recordId) {
        availablePayments.delete(recordId);
      }

      const payload = {
        rowId: row.rowId,
        matchKind: best.kind,
        recordId,
        vendorId: readVendorId(best.record),
        vendorName: readVendorName(best.record),
        statementAmount: row.amount ?? row.credit ?? row.debit,
        booksAmount: readAmount(best.record),
        statementDate: row.date,
        booksDate: readTransactionDate(best.record) ?? asString(best.record.due_date),
        score: Number(best.candidate.score.toFixed(2)),
        reasons: best.candidate.reasons,
        reference: row.reference ?? readReference(best.record),
      };
      if (best.candidate.score >= 0.8) {
        matchedBills.push(payload);
      } else {
        probableMatches.push(payload);
      }
    }

    const unmatchedBooksBills = [...availableBills.values()].map((bill) => ({
      billId: asString(bill.bill_id) ?? asString(bill.id),
      vendorId: readVendorId(bill),
      vendorName: readVendorName(bill),
      amount: readAmount(bill),
      balance: readBalance(bill),
      dueDate: asString(bill.due_date),
    }));

    const unmatchedVendorPayments = [...availablePayments.values()].map((payment) => ({
      vendorPaymentId: asString(payment.vendor_payment_id) ?? asString(payment.id),
      vendorId: readVendorId(payment),
      vendorName: readVendorName(payment),
      amount: readAmount(payment),
      paymentDate: readTransactionDate(payment),
      reference: readReference(payment),
    }));

    return {
      summary: `Vendor statement reconciliation produced ${matchedBills.length} exact and ${probableMatches.length} probable match(es).`,
      organizationId: billsResult.organizationId,
      matched: matchedBills,
      probableMatches,
      unmatchedStatementRows: unmatchedRows,
      unmatchedBooksBills,
      unmatchedVendorPayments,
    };
  }
}

export const zohoFinanceOpsService = new ZohoFinanceOpsService();
