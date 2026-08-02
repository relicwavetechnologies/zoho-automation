/**
 * ZohoCrmOps — deterministic CRM report builders for Zoho CRM.
 *
 * Design principles (same as ZohoFinanceOps):
 *   1. ALL filtering is done in CODE, not by the LLM.
 *   2. Pagination is exhaustive: loops pages up to 50 × 200 = 10,000 records.
 *   3. Token budget: LLM receives summary + top-N inline. The full dataset
 *      leaves only through the central governed export offer.
 *   4. No LLM calls — pure data transformation.
 */

import type { ZohoCrmPaginatedClient } from '../../infrastructure/zoho/zoho-crm-paginated.client';
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
  sourceTruncated:  boolean;
}

export interface DealForecastResult {
  summary:          string;
  totalDeals:       number;
  totalAmount:      number;
  currency:         string;
  byStage:          Array<{ stage: string; count: number; amount: number }>;
  inlineDeals:      Array<Record<string, unknown>>;
  sourceTruncated:  boolean;
}

// ─── CRM Ops ──────────────────────────────────────────────────────────────────

export class ZohoCrmOps {
  constructor(
    private readonly crmClient:       ZohoCrmPaginatedClient,
    private readonly logger:          Logger,
    private readonly inlineThreshold: number = 10,
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

    const stageBreakdown = stages
      .map(s => `${s.stage}: ${s.count} deal(s), ${formatAmount(s.totalAmount, currency)}`)
      .join('; ');

    let summary = deals.length > 0
      ? `Pipeline: ${deals.length} deal(s) worth ${formatAmount(totalPipelineValue, currency)}. ${stageBreakdown}.`
      : 'No deals found in the CRM pipeline.';

    if (truncated) summary += ' Pagination limit reached — additional deals may exist.';

    return {
      summary,
      totalDeals: deals.length,
      totalPipelineValue,
      currency,
      stages,
      inlineDeals,
      sourceTruncated: truncated,
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

    const sourceBreakdown = sources
      .slice(0, 5)
      .map(s => `${s.source}: ${s.count}`)
      .join(', ');

    let summary = leads.length > 0
      ? `Lead funnel: ${leads.length} lead(s). Top sources: ${sourceBreakdown}.`
      : 'No leads found in CRM.';

    if (truncated) summary += ' Pagination limit reached — additional leads may exist.';

    return {
      summary,
      totalLeads: leads.length,
      sources,
      statusBreakdown,
      inlineLeads,
      sourceTruncated: truncated,
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

    const dateRange = input.closingFrom && input.closingTo
      ? ` (${input.closingFrom} to ${input.closingTo})`
      : input.closingFrom ? ` (from ${input.closingFrom})` : input.closingTo ? ` (until ${input.closingTo})` : '';

    let summary = filtered.length > 0
      ? `Deal forecast${dateRange}: ${filtered.length} deal(s) worth ${formatAmount(totalAmount, currency)}.`
      : `No deals closing${dateRange}.`;

    if (truncated) summary += ' Pagination limit reached — additional deals may exist.';

    return {
      summary,
      totalDeals: filtered.length,
      totalAmount,
      currency,
      byStage,
      inlineDeals,
      sourceTruncated: truncated,
    };
  }
}
