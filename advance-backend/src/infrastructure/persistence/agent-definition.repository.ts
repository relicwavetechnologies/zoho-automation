/**
 * AgentDefinitionRepository
 *
 * Reads AgentDefinition + ChannelAgentMapping from Prisma.
 *
 * Resolution order for findRootByChannel:
 *   1. Exact match  — (companyId, channelType, channelIdentifier)
 *   2. Wildcard     — (companyId, channelType, '*')
 *   3. Company root — first active AgentDefinition where isRootAgent=true
 *
 * Children are loaded one level deep (specialists).
 */

import type { PrismaClient } from '../../generated/prisma';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { ok, err, type Result } from '../../shared/result';

// ─── View types ───────────────────────────────────────────────────────────────

export interface AgentDefinitionView {
  readonly id:           string;
  readonly companyId:    string;
  readonly name:         string;
  readonly description?: string;
  readonly systemPrompt: string;
  readonly isRootAgent:  boolean;
  readonly toolIds:      string[];
  readonly modelId?:     string;
  readonly provider?:    string;
  readonly parentId?:    string;
  readonly children:     AgentChildView[];
}

export interface AgentChildView {
  readonly id:           string;
  readonly name:         string;
  readonly description?: string;
  readonly systemPrompt: string;
  readonly toolIds:      string[];
  readonly modelId?:     string;
  readonly provider?:    string;
}

// ─── Prisma select shapes ─────────────────────────────────────────────────────

const childSelect = {
  id:           true,
  name:         true,
  description:  true,
  systemPrompt: true,
  toolIds:      true,
  modelId:      true,
  provider:     true,
} as const;

const rootSelect = {
  id:           true,
  companyId:    true,
  name:         true,
  description:  true,
  systemPrompt: true,
  isRootAgent:  true,
  toolIds:      true,
  modelId:      true,
  provider:     true,
  parentId:     true,
  children:     { where: { isActive: true }, select: childSelect },
} as const;

// ─── Mappers ──────────────────────────────────────────────────────────────────

function mapChild(r: {
  id: string; name: string; description: string | null;
  systemPrompt: string; toolIds: string[];
  modelId: string | null; provider: string | null;
}): AgentChildView {
  return {
    id:           r.id,
    name:         r.name,
    systemPrompt: r.systemPrompt,
    toolIds:      r.toolIds,
    ...(r.description ? { description: r.description } : {}),
    ...(r.modelId     ? { modelId:     r.modelId }     : {}),
    ...(r.provider    ? { provider:    r.provider }    : {}),
  };
}

function mapRoot(r: {
  id: string; companyId: string; name: string; description: string | null;
  systemPrompt: string; isRootAgent: boolean; toolIds: string[];
  modelId: string | null; provider: string | null; parentId: string | null;
  children: Array<{
    id: string; name: string; description: string | null;
    systemPrompt: string; toolIds: string[];
    modelId: string | null; provider: string | null;
  }>;
}): AgentDefinitionView {
  return {
    id:           r.id,
    companyId:    r.companyId,
    name:         r.name,
    systemPrompt: r.systemPrompt,
    isRootAgent:  r.isRootAgent,
    toolIds:      r.toolIds,
    children:     r.children.map(mapChild),
    ...(r.description ? { description: r.description } : {}),
    ...(r.modelId     ? { modelId:     r.modelId }     : {}),
    ...(r.provider    ? { provider:    r.provider }    : {}),
    ...(r.parentId    ? { parentId:    r.parentId }    : {}),
  };
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class AgentDefinitionRepository {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Resolve the root AgentDefinition for a given channel message.
   * Tries exact mapping, then wildcard, then company root.
   */
  async findRootByChannel(
    companyId:         string,
    channelType:       string,
    channelIdentifier: string,
  ): Promise<Result<AgentDefinitionView | null, InfraError>> {
    try {
      // 1. Try exact channel mapping
      const exactMapping = await this.db.channelAgentMapping.findFirst({
        where: {
          companyId,
          channelType,
          channelIdentifier,
          isActive:        true,
          agentDefinition: { isActive: true },
        },
        include: {
          agentDefinition: { select: rootSelect },
        },
      });

      if (exactMapping) {
        return ok(mapRoot(exactMapping.agentDefinition));
      }

      // 2. Try wildcard mapping ('*' identifier for channel type)
      const wildcardMapping = await this.db.channelAgentMapping.findFirst({
        where: {
          companyId,
          channelType,
          channelIdentifier: '*',
          isActive:          true,
          agentDefinition:   { isActive: true },
        },
        include: {
          agentDefinition: { select: rootSelect },
        },
      });

      if (wildcardMapping) {
        return ok(mapRoot(wildcardMapping.agentDefinition));
      }

      // 3. Fall back to company root agent
      const root = await this.db.agentDefinition.findFirst({
        where:   { companyId, isRootAgent: true, isActive: true, parentId: null },
        select:  rootSelect,
        orderBy: { createdAt: 'asc' },
      });

      return ok(root ? mapRoot(root) : null);
    } catch (e) {
      return err(wrapInfra('prisma', 'AgentDefinition.findRootByChannel', e));
    }
  }

  /** All active definitions for a company (flat list, no children). */
  async findAllForCompany(
    companyId: string,
  ): Promise<Result<AgentDefinitionView[], InfraError>> {
    try {
      const rows = await this.db.agentDefinition.findMany({
        where:   { companyId, isActive: true },
        select:  rootSelect,
        orderBy: { createdAt: 'asc' },
      });
      return ok(rows.map(mapRoot));
    } catch (e) {
      return err(wrapInfra('prisma', 'AgentDefinition.findAllForCompany', e));
    }
  }

  /** Find a single definition by ID, with children. */
  async findById(
    id: string,
  ): Promise<Result<AgentDefinitionView | null, InfraError>> {
    try {
      const row = await this.db.agentDefinition.findUnique({
        where:  { id },
        select: rootSelect,
      });
      return ok(row ? mapRoot(row) : null);
    } catch (e) {
      return err(wrapInfra('prisma', 'AgentDefinition.findById', e));
    }
  }
}
