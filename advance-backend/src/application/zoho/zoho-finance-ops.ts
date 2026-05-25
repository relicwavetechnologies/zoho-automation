/**
 * ZohoFinanceOps — deterministic financial report builders for Zoho Books.
 *
 * Design principles:
 *   1. ALL filtering is done in CODE, not by the LLM. "Overdue" means
 *      due_date < today AND status ∈ {overdue, sent, partially_paid} — computed here.
 *   2. Pagination is exhaustive: loops has_more_page up to 20 × 200 = 4 000 records.
 *   3. Token budget is enforced by the tool layer:
 *        - LLM always receives: summary stats + top-N inline records
 *        - Full dataset > INLINE_THRESHOLD → CSV uploaded to Cloudinary → signed link
 *   4. No LLM calls in this file — pure data transformation.
 *
 * Ported from:
 *   backend/src/company/integrations/zoho/zoho-finance-ops.service.ts
 */

import type { ZohoBooksPaginatedClient } from '../../infrastructure/zoho/zoho-books-paginated.client';
import type { CloudinaryAdapter }         from '../../infrastructure/cloudinary/cloudinary.adapter';
import type { Logger }                    from '../../shared/logger';
import { formatAmount }                   from './zoho-format.utils';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const asString  = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
const asNumber  = (v: unknown): number | undefined => typeof v === 'number' && isFinite(v) ? v : undefined;

function readBalance(r: Record<string, unknown>): number {
  return (
    asNumber(r['balance'])          ??
    asNumber(r['amount_due'])       ??
    asNumber(r['outstanding_balance']) ?? 0
  );
}

function readAmount(r: Record<string, unknown>): number {
  return asNumber(r['total']) ?? asNumber(r['amount']) ?? 0;
}

function readInvoiceId(r: Record<string, unknown>): string | undefined {
  return asString(r['invoice_id']) ?? asString(r['id']);
}

function readInvoiceNumber(r: Record<string, unknown>): string | undefined {
  return asString(r['invoice_number']) ?? asString(r['number']);
}

function readCustomerId(r: Record<string, unknown>): string | undefined {
  return asString(r['customer_id']) ?? asString(r['contact_id']);
}

function readCustomerName(r: Record<string, unknown>): string | undefined {
  return asString(r['customer_name']) ?? asString(r['contact_name']) ?? asString(r['company_name']);
}

function parseDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d;
}

/** Days between two dates. Positive = right is BEFORE left (overdue). */
function diffInDays(asOf: Date, due: Date | undefined): number {
  if (!due) return 0;
  return Math.floor((asOf.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
}

function isWithinRange(d: Date | undefined, from: Date | undefined, to: Date | undefined): boolean {
  if (!d) return true;
  if (from && d < from) return false;
  if (to   && d > to)   return false;
  return true;
}

// ─── CSV serialization ────────────────────────────────────────────────────────

function escapeCsvCell(v: unknown): string {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function recordsToCsv(headers: string[], rows: Array<Record<string, unknown>>): Buffer {
  const lines: string[] = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => escapeCsvCell(row[h])).join(','));
  }
  return Buffer.from(lines.join('\n'), 'utf-8');
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OverdueInvoice {
  invoiceId?:     string;
  invoiceNumber?: string;
  customerId?:    string;
  customerName?:  string;
  currencyCode:   string;
  status:         string;
  dueDate?:       string;
  invoiceDate?:   string;
  total:          number;
  balance:        number;
  overdueDays:    number;
}

export interface AgingBuckets {
  current:     number;
  days_1_30:   number;
  days_31_60:  number;
  days_61_90:  number;
  days_91_plus: number;
}

export interface TopCustomer {
  customerId?:   string;
  customerName?: string;
  currencyCode:  string;
  balance:       number;
  invoiceCount:  number;
}

export interface OverdueReportResult {
  /** One-line summary safe to include in LLM context. */
  summary:              string;
  asOfDate:             string;
  organizationId?:      string;
  invoiceCount:         number;
  totalOutstanding:     number;
  bucketTotals:         AgingBuckets;
  topCustomers:         TopCustomer[];
  /** Always ≤ inlineThreshold — what goes directly into LLM context. */
  inlineInvoices:       OverdueInvoice[];
  /** Set when totalCount > inlineThreshold — Cloudinary signed URL. */
  csvLink?:             string;
  csvPublicId?:         string;
  csvExpiresAt?:        string;
  sourceTruncated:      boolean;
  appliedFilters: {
    minOverdueDays:  number;
    invoiceDateFrom?: string;
    invoiceDateTo?:   string;
  };
}

// ─── Finance Ops ──────────────────────────────────────────────────────────────

export class ZohoFinanceOps {
  constructor(
    private readonly booksClient:     ZohoBooksPaginatedClient,
    private readonly cloudinary:      CloudinaryAdapter,
    private readonly logger:          Logger,
    private readonly inlineThreshold: number = 10,
    private readonly csvLinkTtl:      number = 86_400,
  ) {}

  /**
   * Build a full overdue invoice report.
   *
   * Steps:
   *   1. Paginate ALL invoices with status=overdue (up to 20 × 200 = 4 000)
   *   2. Filter deterministically: balance > 0, overdueDays >= minOverdueDays, date range
   *   3. Compute aging buckets + top-10 customers
   *   4. If total > inlineThreshold → serialize CSV → upload Cloudinary → return link
   *   5. Return bounded result (top-N inline + summary + optional link)
   */
  async buildOverdueReport(input: {
    companyId:        string;
    organizationId?:  string;
    asOfDate?:        string;
    minOverdueDays?:  number;
    invoiceDateFrom?: string;
    invoiceDateTo?:   string;
  }): Promise<OverdueReportResult> {
    const asOfDate      = parseDate(input.asOfDate) ?? new Date();
    const minOverdue    = Math.max(0, input.minOverdueDays ?? 1);
    const dateFrom      = parseDate(input.invoiceDateFrom);
    const dateTo        = parseDate(input.invoiceDateTo);

    this.logger.info('zoho.finance.overdue_report.start', {
      companyId: input.companyId,
      asOfDate:  asOfDate.toISOString(),
      minOverdue,
    });

    // ── 1. Exhaust all overdue invoice pages ─────────────────────────────────
    const { organizationId, items: rawInvoices, truncated } = await this.booksClient.listAllRecords({
      companyId:  input.companyId,
      moduleName: 'invoices',
      filters:    { status: 'overdue' },
      ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
    });

    this.logger.info('zoho.finance.overdue_report.scanned', {
      companyId: input.companyId,
      rawCount:  rawInvoices.length,
      truncated,
    });

    // ── 2. Deterministic filter + enrich ─────────────────────────────────────
    type EnrichedInvoice = OverdueInvoice & { _invoiceDate: Date | undefined };

    const enriched: OverdueInvoice[] = rawInvoices
      .map((r): EnrichedInvoice => {
        const dueDate      = parseDate(asString(r['due_date']));
        const invoiceDate  = parseDate(asString(r['date']));
        const invoiceId    = readInvoiceId(r);
        const invoiceNum   = readInvoiceNumber(r);
        const customerId   = readCustomerId(r);
        const customerName = readCustomerName(r);
        const dueDateStr   = asString(r['due_date']);
        const invDateStr   = asString(r['date']);
        return {
          ...(invoiceId    !== undefined ? { invoiceId: invoiceId }       : {}),
          ...(invoiceNum   !== undefined ? { invoiceNumber: invoiceNum }   : {}),
          ...(customerId   !== undefined ? { customerId: customerId }      : {}),
          ...(customerName !== undefined ? { customerName: customerName }  : {}),
          currencyCode:  asString(r['currency_code']) ?? asString(r['currency']) ?? 'INR',
          status:        asString(r['status']) ?? 'unknown',
          ...(dueDateStr  !== undefined ? { dueDate: dueDateStr }         : {}),
          ...(invDateStr  !== undefined ? { invoiceDate: invDateStr }     : {}),
          total:         readAmount(r),
          balance:       readBalance(r),
          overdueDays:   diffInDays(asOfDate, dueDate),
          _invoiceDate:  invoiceDate,
        };
      })
      .filter(inv =>
        inv.balance > 0 &&
        inv.overdueDays >= minOverdue &&
        isWithinRange(inv._invoiceDate, dateFrom, dateTo),
      )
      .map(({ _invoiceDate: _d, ...inv }) => inv)
      .sort((a, b) => b.overdueDays - a.overdueDays);  // most overdue first

    // ── 3. Aggregates (pure math — no LLM) ───────────────────────────────────
    const bucketTotals: AgingBuckets = {
      current:      0,
      days_1_30:    0,
      days_31_60:   0,
      days_61_90:   0,
      days_91_plus: 0,
    };

    const customerMap = new Map<string, TopCustomer>();

    for (const inv of enriched) {
      // Aging buckets
      if      (inv.overdueDays <= 0)  bucketTotals.current      += inv.balance;
      else if (inv.overdueDays <= 30) bucketTotals.days_1_30    += inv.balance;
      else if (inv.overdueDays <= 60) bucketTotals.days_31_60   += inv.balance;
      else if (inv.overdueDays <= 90) bucketTotals.days_61_90   += inv.balance;
      else                            bucketTotals.days_91_plus  += inv.balance;

      // Top customer accumulation
      const key = inv.customerId ?? inv.customerName ?? inv.invoiceId ?? 'unknown';
      const existing = customerMap.get(key) ?? {
        ...(inv.customerId   !== undefined ? { customerId:   inv.customerId }   : {}),
        ...(inv.customerName !== undefined ? { customerName: inv.customerName } : {}),
        currencyCode: inv.currencyCode,
        balance:      0,
        invoiceCount: 0,
      } satisfies TopCustomer;
      existing.balance      += inv.balance;
      existing.invoiceCount += 1;
      customerMap.set(key, existing);
    }

    const topCustomers    = [...customerMap.values()]
      .sort((a, b) => b.balance - a.balance)
      .slice(0, 10);

    const totalOutstanding = enriched.reduce((s, inv) => s + inv.balance, 0);
    const invoiceCount     = enriched.length;
    const inlineInvoices   = enriched.slice(0, this.inlineThreshold);

    // ── 4. CSV export for large result sets ──────────────────────────────────
    let csvLink:     string | undefined;
    let csvPublicId: string | undefined;
    let csvExpiresAt: string | undefined;

    if (invoiceCount > this.inlineThreshold && this.cloudinary.isAvailable) {
      try {
        const csvHeaders = [
          'invoiceId', 'invoiceNumber', 'customerName', 'customerId',
          'currencyCode', 'status', 'dueDate', 'invoiceDate', 'total', 'balance', 'overdueDays',
        ];
        const csvBuffer  = recordsToCsv(csvHeaders, enriched as unknown as Array<Record<string, unknown>>);
        const dateStr    = asOfDate.toISOString().slice(0, 10);
        const fileName   = `overdue_invoices_${dateStr}_${input.companyId.slice(0, 8)}.csv`;

        const exported = await this.cloudinary.uploadCsvBuffer({
          buffer:     csvBuffer,
          fileName,
          companyId:  input.companyId,
          ttlSeconds: this.csvLinkTtl,
        });

        if (exported) {
          csvLink     = exported.signedUrl;
          csvPublicId = exported.publicId;
          csvExpiresAt = exported.expiresAt;

          this.logger.info('zoho.finance.overdue_report.csv_exported', {
            companyId:  input.companyId,
            invoices:   invoiceCount,
            fileName,
            expiresAt:  csvExpiresAt,
          });
        }
      } catch (e) {
        this.logger.warn('zoho.finance.overdue_report.csv_failed', {
          companyId: input.companyId,
          error:     String(e),
        });
        // Non-fatal — inline data still returned
      }
    }

    // ── 5. Build summary string (goes verbatim into LLM context) ─────────────
    // Group totals by currency so multi-currency orgs get correct display
    const currencyTotals = new Map<string, number>();
    for (const inv of enriched) {
      const cur = inv.currencyCode;
      currencyTotals.set(cur, (currencyTotals.get(cur) ?? 0) + inv.balance);
    }
    const formattedTotal = [...currencyTotals.entries()]
      .map(([cur, amt]) => formatAmount(amt, cur))
      .join(', ');

    let summary = invoiceCount > 0
      ? `Found ${invoiceCount} overdue invoice(s) totalling ${formattedTotal}.`
      : 'No overdue invoices matched the current criteria.';

    if (invoiceCount > this.inlineThreshold) {
      summary += ` Showing top ${inlineInvoices.length} by overdue days.`;
    }
    if (csvLink) {
      summary += ` Full dataset available as CSV (link expires in 24 h).`;
    }
    if (truncated) {
      summary += ' Note: pagination limit reached — additional invoices may exist beyond the scan window.';
    }

    return {
      summary,
      asOfDate:         asOfDate.toISOString(),
      organizationId,
      invoiceCount,
      totalOutstanding,
      bucketTotals,
      topCustomers,
      inlineInvoices,
      sourceTruncated:  truncated,
      appliedFilters: {
        minOverdueDays:  minOverdue,
        ...(input.invoiceDateFrom ? { invoiceDateFrom: input.invoiceDateFrom } : {}),
        ...(input.invoiceDateTo   ? { invoiceDateTo:   input.invoiceDateTo   } : {}),
      },
      ...(csvLink     ? { csvLink }     : {}),
      ...(csvPublicId ? { csvPublicId } : {}),
      ...(csvExpiresAt ? { csvExpiresAt } : {}),
    };
  }
}
