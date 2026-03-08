import { zohoDataClient } from './zoho-data.client';
import { ZohoIntegrationError } from './zoho.errors';
import type {
  ZohoProviderActionInput,
  ZohoProviderAdapter,
  ZohoProviderContext,
  ZohoProviderHealth,
  ZohoProviderHistoricalPageInput,
  ZohoProviderHistoricalPageResult,
} from './zoho-provider.adapter';

export class ZohoRestAdapter implements ZohoProviderAdapter {
  readonly mode = 'rest' as const;

  async discoverCapabilities(_context: ZohoProviderContext): Promise<string[]> {
    return ['historical.fetch', 'record.fetch'];
  }

  async health(context: ZohoProviderContext): Promise<ZohoProviderHealth> {
    const startedAt = Date.now();
    try {
      await zohoDataClient.fetchHistoricalPage({
        companyId: context.companyId,
        environment: context.environment,
        pageSize: 1,
      });
      return {
        ok: true,
        status: 'healthy',
        providerMode: this.mode,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      const failureCode = error instanceof ZohoIntegrationError ? error.code : 'unknown';
      return {
        ok: false,
        status: failureCode === 'rate_limited' ? 'degraded' : 'failed',
        providerMode: this.mode,
        latencyMs: Date.now() - startedAt,
        reasonCode: failureCode,
      };
    }
  }

  async fetchHistoricalPage(input: ZohoProviderHistoricalPageInput): Promise<ZohoProviderHistoricalPageResult> {
    const page = await zohoDataClient.fetchHistoricalPage({
      companyId: input.context.companyId,
      environment: input.context.environment,
      cursor: input.cursor,
      pageSize: input.pageSize,
      sourceType: input.sourceType,
      sortBy: input.sortBy,
      sortOrder: input.sortOrder,
    });
    return {
      records: page.records,
      nextCursor: page.nextCursor,
      total: page.total,
    };
  }

  async fetchRecordBySource(input: {
    context: ZohoProviderContext;
    sourceType: 'zoho_lead' | 'zoho_contact' | 'zoho_deal' | 'zoho_ticket';
    sourceId: string;
  }): Promise<Record<string, unknown> | null> {
    return zohoDataClient.fetchRecordBySource({
      companyId: input.context.companyId,
      environment: input.context.environment,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    });
  }

  async executeAction(input: ZohoProviderActionInput): Promise<{
    actionName: string;
    status: 'success' | 'failed';
    failureCode?: 'mcp_action_requires_hitl' | 'mcp_unavailable';
    message?: string;
  }> {
    if (!input.hitlConfirmed) {
      return {
        actionName: input.actionName,
        status: 'failed',
        failureCode: 'mcp_action_requires_hitl',
        message: 'HITL confirmation is required for side effects',
      };
    }

    return {
      actionName: input.actionName,
      status: 'failed',
      failureCode: 'mcp_unavailable',
      message: 'REST provider does not support action execution in MCP mode',
    };
  }
}

export const zohoRestAdapter = new ZohoRestAdapter();
