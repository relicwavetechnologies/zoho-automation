import type { AgentInvokeInputDTO } from '../../contracts';
import { zohoHistoricalAdapter } from '../../integrations/zoho';
import { BaseAgent } from '../base';

const pickCompanyId = (input: AgentInvokeInputDTO): string => {
  const scopedCompanyId = input.contextPacket.companyId;
  if (typeof scopedCompanyId === 'string' && scopedCompanyId.trim().length > 0) {
    return scopedCompanyId;
  }
  return `demo-${input.taskId.slice(0, 8)}`;
};

export class ZohoReadAgent extends BaseAgent {
  readonly key = 'zoho-read';

  async invoke(input: AgentInvokeInputDTO) {
    const companyId = pickCompanyId(input);
    const batch = await zohoHistoricalAdapter.fetchHistoricalBatch({
      companyId,
      pageSize: 3,
    });

    return this.success(
      input,
      `Zoho read completed (${batch.records.length} records sampled)`,
      {
        companyId,
        total: batch.total,
        nextCursor: batch.nextCursor ?? null,
        records: batch.records.map((record) => ({
          sourceType: record.sourceType,
          sourceId: record.sourceId,
        })),
      },
      { latencyMs: 6, apiCalls: 1 },
    );
  }
}
