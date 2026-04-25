/**
 * AgentResolver — resolves the root AgentDefinition for an incoming message.
 *
 * Resolution order (same as repository):
 *   1. Exact ChannelAgentMapping
 *   2. Wildcard ChannelAgentMapping ('*')
 *   3. Company root (isRootAgent=true)
 *   4. null — no agent configured; engine falls back to single-engine mode
 *
 * Results are Redis-cached for 5 minutes to avoid a DB hit on every message.
 * Cache is keyed by (companyId, channelType, channelIdentifier).
 * On cache miss the parsed result is validated — stale/corrupt cache = miss.
 */

import type { AgentDefinitionRepository, AgentDefinitionView } from '../../../infrastructure/persistence/agent-definition.repository';
import type { CachePort } from '../../../shared/cache';
import type { Logger } from '../../../shared/logger';

const CACHE_TTL_SECONDS = 300; // 5 minutes

function cacheKey(companyId: string, channelType: string, channelId: string): string {
  return `agent:root:${companyId}:${channelType}:${channelId}`;
}

const SENTINEL_NULL = '__null__';

export class AgentResolver {
  private readonly log: Logger;

  constructor(
    private readonly repo:   AgentDefinitionRepository,
    private readonly cache:  CachePort,
    logger:                  Logger,
  ) {
    this.log = logger.child({ service: 'agent-resolver' });
  }

  /**
   * Returns the root AgentDefinitionView (with children) for the given channel,
   * or null if no agent is configured for this company.
   */
  async resolve(
    companyId:   string,
    channelType: string,
    channelId:   string,
  ): Promise<AgentDefinitionView | null> {
    const key = cacheKey(companyId, channelType, channelId);

    // ── 1. Redis cache ────────────────────────────────────────────────────
    const cached = await this.cache.get<AgentDefinitionView | typeof SENTINEL_NULL>(key);
    if (cached.ok && cached.value !== null) {
      if (cached.value === SENTINEL_NULL) return null;
      // Basic shape validation
      if (typeof (cached.value as AgentDefinitionView).id === 'string') {
        return cached.value as AgentDefinitionView;
      }
    }

    // ── 2. DB lookup ──────────────────────────────────────────────────────
    const result = await this.repo.findRootByChannel(companyId, channelType, channelId);

    if (!result.ok) {
      this.log.warn('agent-resolver.db.error', { companyId, channelType, error: result.error.message });
      return null; // degrade gracefully — engine runs without agent config
    }

    const agentDef = result.value;

    // ── 3. Cache result (or absence of result) ────────────────────────────
    await this.cache.set(key, agentDef ?? SENTINEL_NULL, CACHE_TTL_SECONDS);

    if (agentDef) {
      this.log.debug('agent-resolver.resolved', {
        companyId,
        channelType,
        agentName:    agentDef.name,
        childCount:   agentDef.children.length,
      });
    } else {
      this.log.debug('agent-resolver.no_agent_configured', { companyId, channelType });
    }

    return agentDef;
  }

  /** Invalidate cached agent config for a company (call after admin changes). */
  async invalidate(companyId: string): Promise<void> {
    await this.cache.scanDel(`agent:root:${companyId}:*`);
    this.log.info('agent-resolver.cache.invalidated', { companyId });
  }
}
