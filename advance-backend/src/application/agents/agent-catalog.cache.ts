import type { DynamicAgentDescriptor } from './dynamic-agent-descriptor';
import type { AgentCatalogService } from './agent-catalog.service';
import type { Logger } from '../../shared/logger';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
  readonly agents: DynamicAgentDescriptor[];
  readonly loadedAtMs: number;
};

export class AgentCatalogCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly log: Logger;

  constructor(
    private readonly service: AgentCatalogService,
    logger: Logger,
    opts: { ttlMs?: number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.log = logger.child({ service: 'agent-catalog-cache' });
  }

  async getForCompany(companyId: string): Promise<DynamicAgentDescriptor[]> {
    const now = Date.now();
    const cached = this.entries.get(companyId);
    if (cached && now - cached.loadedAtMs < this.ttlMs) {
      return cached.agents;
    }

    const agents = await this.service.listActiveForCompany(companyId);
    this.entries.set(companyId, { agents, loadedAtMs: now });
    this.log.debug('agent_catalog_cache.loaded', { companyId, count: agents.length });
    return agents;
  }

  async getRootAgent(companyId: string): Promise<DynamicAgentDescriptor | null> {
    const agents = await this.getForCompany(companyId);
    return agents.find(agent => agent.isRootAgent && agent.parentId === null) ?? null;
  }

  async getChildrenOf(companyId: string, parentId: string): Promise<DynamicAgentDescriptor[]> {
    const agents = await this.getForCompany(companyId);
    return agents.filter(agent => agent.parentId === parentId);
  }

  invalidate(companyId: string): void {
    this.entries.delete(companyId);
    this.log.info('agent_catalog_cache.invalidated', { companyId });
  }
}
