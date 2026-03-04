export type ZohoHistoricalSourceType = 'zoho_contact' | 'zoho_deal' | 'zoho_ticket';

export type ZohoHistoricalRecord = {
  sourceType: ZohoHistoricalSourceType;
  sourceId: string;
  payload: Record<string, unknown>;
};

export type ZohoHistoricalFetchInput = {
  companyId: string;
  cursor?: string;
  pageSize: number;
};

export type ZohoHistoricalFetchResult = {
  records: ZohoHistoricalRecord[];
  nextCursor?: string;
  total: number;
};

const buildSyntheticDataset = (companyId: string): ZohoHistoricalRecord[] => [
  {
    sourceType: 'zoho_contact',
    sourceId: `${companyId}-contact-1`,
    payload: { module: 'contacts', name: 'Primary Contact', email: 'primary@example.com' },
  },
  {
    sourceType: 'zoho_contact',
    sourceId: `${companyId}-contact-2`,
    payload: { module: 'contacts', name: 'Secondary Contact', email: 'secondary@example.com' },
  },
  {
    sourceType: 'zoho_deal',
    sourceId: `${companyId}-deal-1`,
    payload: { module: 'deals', title: 'Initial Deal', amount: 15000, stage: 'Qualified' },
  },
  {
    sourceType: 'zoho_ticket',
    sourceId: `${companyId}-ticket-1`,
    payload: { module: 'tickets', subject: 'Onboarding question', priority: 'high' },
  },
  {
    sourceType: 'zoho_deal',
    sourceId: `${companyId}-deal-2`,
    payload: { module: 'deals', title: 'Expansion Deal', amount: 35000, stage: 'Proposal' },
  },
  {
    sourceType: 'zoho_ticket',
    sourceId: `${companyId}-ticket-2`,
    payload: { module: 'tickets', subject: 'Contract clarifications', priority: 'medium' },
  },
];

export class ZohoHistoricalAdapter {
  async fetchHistoricalBatch(input: ZohoHistoricalFetchInput): Promise<ZohoHistoricalFetchResult> {
    const dataset = buildSyntheticDataset(input.companyId);
    const offset = Number(input.cursor ?? '0');
    const start = Number.isFinite(offset) && offset >= 0 ? offset : 0;
    const end = Math.min(start + input.pageSize, dataset.length);
    const records = dataset.slice(start, end);

    return {
      records,
      nextCursor: end < dataset.length ? String(end) : undefined,
      total: dataset.length,
    };
  }
}

export const zohoHistoricalAdapter = new ZohoHistoricalAdapter();
