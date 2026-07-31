/**
 * ZohoCrmOps — deterministic CRM report builders for Zoho CRM.
 *
 * Design principles (same as ZohoFinanceOps):
 *   1. ALL filtering is done in CODE, not by the LLM.
 *   2. Pagination is exhaustive: loops pages up to 50 × 200 = 10,000 records.
 *   3. Token budget: LLM receives summary + top-N inline; full dataset → CSV.
 *   4. No LLM calls — pure data transformation.
 */

import type { ZohoCrmPaginatedClient } from '../../infrastructure/zoho/zoho-crm-paginated.client';
import type { CloudinaryAdapter }       from '../../infrastructure/cloudinary/cloudinary.adapter';
import type { Logger }                  from '../../shared/logger';
import { formatAmount }                 from './zoho-format.utils';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const asString = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
const asNumber = (v: unknown): number | undefined => typeof v === 'number' && isFinite(v) ? v : undefined;

function readAmount(r: Record<string, unknown>): number {
  return asNumber(r['Amount']) ?? 0;
}

function readOwnerName(r: Record<string, unknown>): string {
  const owner = r['Owner'];
  if (owner && typeof owner === 'object' && !Array.isArray(owner)) {
    return asString((owner as Record<string, unknown>)['name']) ?? 'Unknown';
  }
  return 'Unknown';
}

function readLookupName(r: Record<string, unknown>, field: string): string {
  const val = r[field];
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return asString((val as Record<string, unknown>)['name']) ?? '';
  }
  return '';
}

function parseDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d;
}

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

export interface PipelineStage {
  stage:      string;
  count:      number;
  totalAmount: number;
  currency:   string;
  deals:      Array<{
    dealName:    string;
    amount:      number;
    accountName: string;
    owner:       string;
    closingDate: string;
  }>;
}

export interface PipelineSummaryResult {
  summary:          string;
  totalDeals:       number;
  totalPipelineValue: number;
  currency:         string;
  stages:           PipelineStage[];
  inlineDeals:      Array<Record<string, unknown>>;
  csvLink?:         string;
  csvPublicId?:     string;
  csvExpiresAt?:    string;
  sourceTruncated:  boolean;
}

export interface LeadSourceGroup {
  source:   string;
  count:    number;
  statuses: Record<string, number>;
}

export interface LeadReportResult {
  summary:          string;
  totalLeads:       number;
  sources:          LeadSourceGroup[];
  statusBreakdown:  Record<string, number>;
  inlineLeads:      Array<Record<string, unknown>>;
  csvLink?:         string;
  csvPublicId?:     string;
  csvExpiresAt?:    string;
  sourceTruncated:  boolean;
}

export interface DealForecastResult {
  summary:          string;
  totalDeals:       number;
  totalAmount:      number;
  currency:         string;
  byStage:          Array<{ stage: string; count: number; amount: number }>;
  inlineDeals:      Array<Record<string, unknown>>;
  csvLink?:         string;
  csvPublicId?:     string;
  csvExpiresAt?:    string;
  sourceTruncated:  boolean;
}

// ─── CRM Ops ──────────────────────────────────────────────────────────────────

export class ZohoCrmOps {
  constructor(
    private readonly crmClient:       ZohoCrmPaginatedClient,
    private readonly cloudinary:      CloudinaryAdapter,
    private readonly logger:          Logger,
    private readonly inlineThreshold: number = 10,
    private readonly csvLinkTtl:      number = 86_400,
  ) {}

  /**
   * Pipeline summary — deals grouped by stage with amounts.
   */
  async buildPipelineSummary(input: {
    companyId: string;
    userId?: string;
    connectionId?: string;
    currency?: string;
  }): Promise<PipelineSummaryResult> {
    this.logger.info('zoho.crm.pipeline_summary.start', { companyId: input.companyId });

    const { items: deals, truncated } = await this.crmClient.listAllRecords({
      companyId: input.companyId,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      module:    'Deals',
    });

    this.logger.info('zoho.crm.pipeline_summary.scanned', {
      companyId: input.companyId,
      dealCount: deals.length,
      truncated,
    });

    const currency = input.currency ?? 'INR';
    const stageMap = new Map<string, PipelineStage>();

    for (const deal of deals) {
      const stage = asString(deal['Stage']) ?? 'Unknown';
      const amount = readAmount(deal);
      const existing = stageMap.get(stage) ?? {
        stage, count: 0, totalAmount: 0, currency,
        deals: [],
      };
      existing.count += 1;
      existing.totalAmount += amount;
      existing.deals.push({
        dealName:    asString(deal['Deal_Name']) ?? '',
        amount,
        accountName: readLookupName(deal, 'Account_Name'),
        owner:       readOwnerName(deal),
        closingDate: asString(deal['Closing_Date']) ?? '',
      });
      stageMap.set(stage, existing);
    }

    const stages = [...stageMap.values()].sort((a, b) => b.totalAmount - a.totalAmount);
    const totalPipelineValue = stages.reduce((s, st) => s + st.totalAmount, 0);

    const inlineDeals = deals.slice(0, this.inlineThreshold);

    let csvLink: string | undefined;
    let csvPublicId: string | undefined;
    let csvExpiresAt: string | undefined;

    if (deals.length > this.inlineThreshold && this.cloudinary.isAvailable) {
      try {
        const csvRows = deals.map(d => ({
          Deal_Name:    asString(d['Deal_Name']) ?? '',
          Stage:        asString(d['Stage']) ?? '',
          Amount:       readAmount(d),
          Account_Name: readLookupName(d, 'Account_Name'),
          Owner:        readOwnerName(d),
          Closing_Date: asString(d['Closing_Date']) ?? '',
        }));
        const headers = ['Deal_Name', 'Stage', 'Amount', 'Account_Name', 'Owner', 'Closing_Date'];
        const csvBuffer = recordsToCsv(headers, csvRows as unknown as Array<Record<string, unknown>>);
        const exported = await this.cloudinary.uploadCsvBuffer({
          buffer:     csvBuffer,
          fileName:   `crm-pipeline-${new Date().toISOString().slice(0, 10)}-${input.companyId.slice(0, 8)}.csv`,
          companyId:  input.companyId,
          ttlSeconds: this.csvLinkTtl,
        });
        if (exported) {
          csvLink = exported.signedUrl;
          csvPublicId = exported.publicId;
          csvExpiresAt = exported.expiresAt;
        }
      } catch (e) {
        this.logger.warn('zoho.crm.pipeline_summary.csv_failed', { error: String(e) });
      }
    }

    const stageBreakdown = stages
      .map(s => `${s.stage}: ${s.count} deal(s), ${formatAmount(s.totalAmount, currency)}`)
      .join('; ');

    let summary = deals.length > 0
      ? `Pipeline: ${deals.length} deal(s) worth ${formatAmount(totalPipelineValue, currency)}. ${stageBreakdown}.`
      : 'No deals found in the CRM pipeline.';

    if (csvLink) summary += ' Full dataset available as CSV.';
    if (truncated) summary += ' Pagination limit reached — additional deals may exist.';

    return {
      summary,
      totalDeals: deals.length,
      totalPipelineValue,
      currency,
      stages,
      inlineDeals,
      sourceTruncated: truncated,
      ...(csvLink ? { csvLink } : {}),
      ...(csvPublicId ? { csvPublicId } : {}),
      ...(csvExpiresAt ? { csvExpiresAt } : {}),
    };
  }

  /**
   * Lead funnel report — leads grouped by source and status.
   */
  async buildLeadReport(input: {
    companyId: string;
    userId?: string;
    connectionId?: string;
  }): Promise<LeadReportResult> {
    this.logger.info('zoho.crm.lead_report.start', { companyId: input.companyId });

    const { items: leads, truncated } = await this.crmClient.listAllRecords({
      companyId: input.companyId,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      module:    'Leads',
    });

    const sourceMap = new Map<string, LeadSourceGroup>();
    const statusBreakdown: Record<string, number> = {};

    for (const lead of leads) {
      const source = asString(lead['Lead_Source']) ?? 'Unknown';
      const status = asString(lead['Lead_Status']) ?? 'Unknown';

      statusBreakdown[status] = (statusBreakdown[status] ?? 0) + 1;

      const existing = sourceMap.get(source) ?? { source, count: 0, statuses: {} };
      existing.count += 1;
      existing.statuses[status] = (existing.statuses[status] ?? 0) + 1;
      sourceMap.set(source, existing);
    }

    const sources = [...sourceMap.values()].sort((a, b) => b.count - a.count);
    const inlineLeads = leads.slice(0, this.inlineThreshold);

    let csvLink: string | undefined;
    let csvPublicId: string | undefined;
    let csvExpiresAt: string | undefined;

    if (leads.length > this.inlineThreshold && this.cloudinary.isAvailable) {
      try {
        const csvRows = leads.map(l => ({
          Name:        `${asString(l['First_Name']) ?? ''} ${asString(l['Last_Name']) ?? ''}`.trim(),
          Email:       asString(l['Email']) ?? '',
          Company:     asString(l['Company']) ?? '',
          Source:      asString(l['Lead_Source']) ?? '',
          Status:      asString(l['Lead_Status']) ?? '',
          Owner:       readOwnerName(l),
          Created:     asString(l['Created_Time']) ?? '',
        }));
        const headers = ['Name', 'Email', 'Company', 'Source', 'Status', 'Owner', 'Created'];
        const csvBuffer = recordsToCsv(headers, csvRows as unknown as Array<Record<string, unknown>>);
        const exported = await this.cloudinary.uploadCsvBuffer({
          buffer:     csvBuffer,
          fileName:   `crm-leads-${new Date().toISOString().slice(0, 10)}-${input.companyId.slice(0, 8)}.csv`,
          companyId:  input.companyId,
          ttlSeconds: this.csvLinkTtl,
        });
        if (exported) {
          csvLink = exported.signedUrl;
          csvPublicId = exported.publicId;
          csvExpiresAt = exported.expiresAt;
        }
      } catch (e) {
        this.logger.warn('zoho.crm.lead_report.csv_failed', { error: String(e) });
      }
    }

    const sourceBreakdown = sources
      .slice(0, 5)
      .map(s => `${s.source}: ${s.count}`)
      .join(', ');

    let summary = leads.length > 0
      ? `Lead funnel: ${leads.length} lead(s). Top sources: ${sourceBreakdown}.`
      : 'No leads found in CRM.';

    if (csvLink) summary += ' Full dataset available as CSV.';
    if (truncated) summary += ' Pagination limit reached — additional leads may exist.';

    return {
      summary,
      totalLeads: leads.length,
      sources,
      statusBreakdown,
      inlineLeads,
      sourceTruncated: truncated,
      ...(csvLink ? { csvLink } : {}),
      ...(csvPublicId ? { csvPublicId } : {}),
      ...(csvExpiresAt ? { csvExpiresAt } : {}),
    };
  }

  /**
   * Deal forecast — deals closing within a date range, grouped by stage.
   */
  async buildDealForecast(input: {
    companyId:     string;
    userId?:       string;
    connectionId?: string;
    closingFrom?:  string;
    closingTo?:    string;
    currency?:     string;
  }): Promise<DealForecastResult> {
    this.logger.info('zoho.crm.deal_forecast.start', { companyId: input.companyId });

    const { items: allDeals, truncated } = await this.crmClient.listAllRecords({
      companyId: input.companyId,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      module:    'Deals',
    });

    const fromDate = parseDate(input.closingFrom);
    const toDate   = parseDate(input.closingTo);
    const currency = input.currency ?? 'INR';

    const filtered = allDeals.filter(d => {
      const closing = parseDate(asString(d['Closing_Date']));
      if (!closing) return false;
      if (fromDate && closing < fromDate) return false;
      if (toDate && closing > toDate) return false;
      return true;
    });

    const stageMap = new Map<string, { stage: string; count: number; amount: number }>();
    let totalAmount = 0;

    for (const deal of filtered) {
      const stage = asString(deal['Stage']) ?? 'Unknown';
      const amount = readAmount(deal);
      totalAmount += amount;

      const existing = stageMap.get(stage) ?? { stage, count: 0, amount: 0 };
      existing.count += 1;
      existing.amount += amount;
      stageMap.set(stage, existing);
    }

    const byStage = [...stageMap.values()].sort((a, b) => b.amount - a.amount);
    const inlineDeals = filtered.slice(0, this.inlineThreshold);

    let csvLink: string | undefined;
    let csvPublicId: string | undefined;
    let csvExpiresAt: string | undefined;

    if (filtered.length > this.inlineThreshold && this.cloudinary.isAvailable) {
      try {
        const csvRows = filtered.map(d => ({
          Deal_Name:    asString(d['Deal_Name']) ?? '',
          Stage:        asString(d['Stage']) ?? '',
          Amount:       readAmount(d),
          Account_Name: readLookupName(d, 'Account_Name'),
          Owner:        readOwnerName(d),
          Closing_Date: asString(d['Closing_Date']) ?? '',
          Probability:  asNumber(d['Probability']) ?? '',
        }));
        const headers = ['Deal_Name', 'Stage', 'Amount', 'Account_Name', 'Owner', 'Closing_Date', 'Probability'];
        const csvBuffer = recordsToCsv(headers, csvRows as unknown as Array<Record<string, unknown>>);
        const exported = await this.cloudinary.uploadCsvBuffer({
          buffer:     csvBuffer,
          fileName:   `crm-forecast-${new Date().toISOString().slice(0, 10)}-${input.companyId.slice(0, 8)}.csv`,
          companyId:  input.companyId,
          ttlSeconds: this.csvLinkTtl,
        });
        if (exported) {
          csvLink = exported.signedUrl;
          csvPublicId = exported.publicId;
          csvExpiresAt = exported.expiresAt;
        }
      } catch (e) {
        this.logger.warn('zoho.crm.deal_forecast.csv_failed', { error: String(e) });
      }
    }

    const dateRange = input.closingFrom && input.closingTo
      ? ` (${input.closingFrom} to ${input.closingTo})`
      : input.closingFrom ? ` (from ${input.closingFrom})` : input.closingTo ? ` (until ${input.closingTo})` : '';

    let summary = filtered.length > 0
      ? `Deal forecast${dateRange}: ${filtered.length} deal(s) worth ${formatAmount(totalAmount, currency)}.`
      : `No deals closing${dateRange}.`;

    if (csvLink) summary += ' Full dataset available as CSV.';
    if (truncated) summary += ' Pagination limit reached — additional deals may exist.';

    return {
      summary,
      totalDeals: filtered.length,
      totalAmount,
      currency,
      byStage,
      inlineDeals,
      sourceTruncated: truncated,
      ...(csvLink ? { csvLink } : {}),
      ...(csvPublicId ? { csvPublicId } : {}),
      ...(csvExpiresAt ? { csvExpiresAt } : {}),
    };
  }
}
