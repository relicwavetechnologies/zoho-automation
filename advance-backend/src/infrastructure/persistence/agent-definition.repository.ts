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

// ─── Admin view types (includes mutable fields for CRUD surface) ──────────────

export interface AgentAdminView {
  readonly id:           string;
  readonly companyId:    string;
  readonly name:         string;
  readonly description?: string;
  readonly systemPrompt: string;
  readonly isRootAgent:  boolean;
  readonly isActive:     boolean;
  readonly toolIds:      string[];
  readonly modelId?:     string;
  readonly provider?:    string;
  readonly parentId?:    string;
  readonly children:     AgentChildView[];
  readonly createdAt:    Date;
  readonly updatedAt:    Date;
}

export interface CreateAgentInput {
  companyId:     string;
  name:          string;
  description?:  string | undefined;
  systemPrompt:  string;
  isRootAgent?:  boolean | undefined;
  toolIds?:      string[] | undefined;
  modelId?:      string | null | undefined;
  provider?:     string | null | undefined;
  parentId?:     string | null | undefined;
}

export interface UpdateAgentInput {
  name?:         string | undefined;
  description?:  string | undefined;
  systemPrompt?: string | undefined;
  isRootAgent?:  boolean | undefined;
  isActive?:     boolean | undefined;
  toolIds?:      string[] | undefined;
  modelId?:      string | null | undefined;
  provider?:     string | null | undefined;
  parentId?:     string | null | undefined;
}

const adminSelect = {
  id:           true,
  companyId:    true,
  name:         true,
  description:  true,
  systemPrompt: true,
  isRootAgent:  true,
  isActive:     true,
  toolIds:      true,
  modelId:      true,
  provider:     true,
  parentId:     true,
  createdAt:    true,
  updatedAt:    true,
  children: { select: childSelect },
} as const;

function mapAdmin(r: {
  id: string; companyId: string; name: string; description: string | null;
  systemPrompt: string; isRootAgent: boolean; isActive: boolean; toolIds: string[];
  modelId: string | null; provider: string | null; parentId: string | null;
  createdAt: Date; updatedAt: Date;
  children: Array<{
    id: string; name: string; description: string | null;
    systemPrompt: string; toolIds: string[];
    modelId: string | null; provider: string | null;
  }>;
}): AgentAdminView {
  return {
    id:           r.id,
    companyId:    r.companyId,
    name:         r.name,
    systemPrompt: r.systemPrompt,
    isRootAgent:  r.isRootAgent,
    isActive:     r.isActive,
    toolIds:      r.toolIds,
    children:     r.children.map(mapChild),
    createdAt:    r.createdAt,
    updatedAt:    r.updatedAt,
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

  // ── Admin CRUD ────────────────────────────────────────────────────────────

  /** All agents for a company (active + inactive) for the admin UI. */
  async adminFindAll(companyId: string): Promise<Result<AgentAdminView[], InfraError>> {
    try {
      const rows = await this.db.agentDefinition.findMany({
        where:   { companyId },
        select:  adminSelect,
        orderBy: { createdAt: 'asc' },
      });
      return ok(rows.map(mapAdmin));
    } catch (e) {
      return err(wrapInfra('prisma', 'AgentDefinition.adminFindAll', e));
    }
  }

  /** Single agent by id scoped to company, including inactive. */
  async adminFindById(id: string, companyId: string): Promise<Result<AgentAdminView | null, InfraError>> {
    try {
      const row = await this.db.agentDefinition.findFirst({
        where:  { id, companyId },
        select: adminSelect,
      });
      return ok(row ? mapAdmin(row) : null);
    } catch (e) {
      return err(wrapInfra('prisma', 'AgentDefinition.adminFindById', e));
    }
  }

  async create(input: CreateAgentInput): Promise<Result<AgentAdminView, InfraError>> {
    try {
      const row = await this.db.agentDefinition.create({
        data: {
          companyId:    input.companyId,
          name:         input.name,
          systemPrompt: input.systemPrompt,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.isRootAgent !== undefined ? { isRootAgent: input.isRootAgent } : {}),
          ...(input.toolIds     !== undefined ? { toolIds:     input.toolIds }     : {}),
          ...(input.modelId     !== undefined ? { modelId:     input.modelId }     : {}),
          ...(input.provider    !== undefined ? { provider:    input.provider }    : {}),
          ...(input.parentId    !== undefined ? { parentId:    input.parentId }    : {}),
        },
        select: adminSelect,
      });
      return ok(mapAdmin(row));
    } catch (e) {
      return err(wrapInfra('prisma', 'AgentDefinition.create', e));
    }
  }

  async update(id: string, companyId: string, input: UpdateAgentInput): Promise<Result<AgentAdminView, InfraError>> {
    try {
      const row = await this.db.agentDefinition.update({
        where: { id },
        data: {
          ...(input.name         !== undefined ? { name:         input.name }         : {}),
          ...(input.description  !== undefined ? { description:  input.description }  : {}),
          ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
          ...(input.isRootAgent  !== undefined ? { isRootAgent:  input.isRootAgent }  : {}),
          ...(input.isActive     !== undefined ? { isActive:     input.isActive }     : {}),
          ...(input.toolIds      !== undefined ? { toolIds:      input.toolIds }      : {}),
          ...(input.modelId      !== undefined ? { modelId:      input.modelId }      : {}),
          ...(input.provider     !== undefined ? { provider:     input.provider }     : {}),
          ...(input.parentId     !== undefined ? { parentId:     input.parentId }     : {}),
        },
        select: adminSelect,
      });
      void companyId; // scoping enforced by service before calling
      return ok(mapAdmin(row));
    } catch (e) {
      return err(wrapInfra('prisma', 'AgentDefinition.update', e));
    }
  }

  async delete(id: string): Promise<Result<void, InfraError>> {
    try {
      await this.db.agentDefinition.delete({ where: { id } });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'AgentDefinition.delete', e));
    }
  }

  /** Count direct children so callers can guard deletion. */
  async countChildren(parentId: string): Promise<Result<number, InfraError>> {
    try {
      const count = await this.db.agentDefinition.count({ where: { parentId } });
      return ok(count);
    } catch (e) {
      return err(wrapInfra('prisma', 'AgentDefinition.countChildren', e));
    }
  }

  /** Walk ancestor chain from startId upward. Returns ordered ancestor IDs. */
  async ancestorIds(startId: string): Promise<Result<string[], InfraError>> {
    try {
      const ids: string[] = [];
      let currentId: string | null = startId;
      while (currentId) {
        const row: { parentId: string | null } | null = await this.db.agentDefinition.findUnique({
          where:  { id: currentId },
          select: { parentId: true },
        });
        currentId = row?.parentId ?? null;
        if (currentId) ids.push(currentId);
      }
      return ok(ids);
    } catch (e) {
      return err(wrapInfra('prisma', 'AgentDefinition.ancestorIds', e));
    }
  }
}
