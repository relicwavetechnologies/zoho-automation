import type { DynamicAgentDescriptor } from './dynamic-agent-descriptor';
import type { AgentDefinitionRepository, AgentDefinitionView } from '../../infrastructure/persistence/agent-definition.repository';
import type { Logger } from '../../shared/logger';

export class AgentCatalogService {
  private readonly log: Logger;

  constructor(
    private readonly repo: AgentDefinitionRepository,
    logger: Logger,
  ) {
    this.log = logger.child({ service: 'agent-catalog' });
  }

  async listActiveForCompany(companyId: string): Promise<DynamicAgentDescriptor[]> {
    const result = await this.repo.findAllForCompany(companyId);
    if (!result.ok) {
      this.log.warn('agent_catalog.load_failed', { companyId, error: result.error.message });
      return [];
    }

    const rows = result.value;
    const childIdsByParent = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.parentId) continue;
      const ids = childIdsByParent.get(row.parentId) ?? [];
      ids.push(row.id);
      childIdsByParent.set(row.parentId, ids);
    }

    return rows.map(row => toDescriptor(row, childIdsByParent.get(row.id) ?? []));
  }
}

export function toDescriptor(
  row: AgentDefinitionView,
  childAgentIds = row.children.map(child => child.id),
): DynamicAgentDescriptor {
  return {
    id:                    row.id,
    companyId:             row.companyId,
    slug:                  row.slug,
    name:                  row.name,
    capabilityDescription: row.capabilityDescription ?? row.description ?? row.name,
    toolIds:               row.toolIds,
    childAgentIds,
    systemPrompt:          row.systemPrompt,
    hookId:                row.hookId ?? null,
    modelId:               row.modelId ?? null,
    provider:              row.provider ?? null,
    maxSteps:              row.maxSteps,
    temperature:           row.temperature,
    isActive:              row.isActive,
    isRootAgent:           row.isRootAgent,
    parentId:              row.parentId ?? null,
  };
}
