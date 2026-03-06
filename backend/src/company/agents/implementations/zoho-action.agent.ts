import type { AgentInvokeInputDTO } from '../../contracts';
import { resolveZohoProvider } from '../../integrations/zoho/zoho-provider.resolver';
import { ZohoIntegrationError } from '../../integrations/zoho/zoho.errors';
import { BaseAgent } from '../base';
import { CompanyContextResolutionError, companyContextResolver } from '../support';

const readObject = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return value as Record<string, unknown>;
};

const readString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const readHitlConfirmed = (input: AgentInvokeInputDTO): boolean => {
  if (input.contextPacket.hitlConfirmed === true) {
    return true;
  }
  return input.contextPacket.hitlStatus === 'confirmed';
};

export class ZohoActionAgent extends BaseAgent {
  readonly key = 'zoho-action';

  async invoke(input: AgentInvokeInputDTO) {
    const startedAt = Date.now();
    try {
      const companyId = await companyContextResolver.resolveCompanyId({
        companyId: input.contextPacket.companyId,
      });
      const provider = await resolveZohoProvider({
        companyId,
      });

      const actionName = readString(input.contextPacket.actionName) ?? 'zoho.execute_action';
      const actionPayload = readObject(input.contextPacket.actionPayload) ?? {
        objective: input.objective,
      };
      const hitlConfirmed = readHitlConfirmed(input);

      const result = await provider.adapter.executeAction({
        context: {
          companyId,
          environment: provider.environment,
          connectionId: provider.connectionId,
        },
        actionName,
        payload: actionPayload,
        hitlConfirmed,
      });

      if (result.status !== 'success') {
        const classifiedReason = result.failureCode ?? 'mcp_unavailable';
        const retriable = classifiedReason === 'mcp_unavailable';
        return this.failure(
          input,
          result.message ?? 'Zoho action failed',
          classifiedReason,
          result.message,
          retriable,
          { latencyMs: Date.now() - startedAt, apiCalls: 1 },
        );
      }

      return this.success(
        input,
        `Zoho action executed successfully via ${provider.providerMode} provider.`,
        {
          companyId,
          providerMode: provider.providerMode,
          actionName: result.actionName,
          receipt: result.receipt,
          sourceRefs: [{ source: provider.providerMode, id: result.actionName }],
        },
        { latencyMs: Date.now() - startedAt, apiCalls: 1 },
      );
    } catch (error) {
      if (error instanceof CompanyContextResolutionError) {
        return this.failure(
          input,
          error.message,
          error.code,
          error.message,
          false,
          { latencyMs: Date.now() - startedAt, apiCalls: 1 },
        );
      }
      if (error instanceof ZohoIntegrationError) {
        return this.failure(
          input,
          `Zoho action integration failed: ${error.message}`,
          error.code,
          error.message,
          error.retriable,
          { latencyMs: Date.now() - startedAt, apiCalls: 1 },
        );
      }

      return this.failure(
        input,
        'Zoho action failed',
        'mcp_unavailable',
        error instanceof Error ? error.message : 'unknown_error',
        true,
        { latencyMs: Date.now() - startedAt, apiCalls: 1 },
      );
    }
  }
}

