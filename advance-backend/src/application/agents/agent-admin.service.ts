/**
 * AgentAdminService
 *
 * Business logic for the admin CRUD surface on AgentDefinition and
 * ChannelAgentMapping. Validates toolIds, enforces parent-cycle safety,
 * and delegates persistence to the repositories.
 */

import type { PrismaClient } from '../../generated/prisma';
import { Prisma } from '../../generated/prisma';
import type { AgentDefinitionRepository, AgentAdminView, CreateAgentInput, UpdateAgentInput } from '../../infrastructure/persistence/agent-definition.repository';
import type { ChannelMappingRepository, ChannelMappingView, SetMappingInput } from '../../infrastructure/persistence/channel-mapping.repository';
import type { Logger } from '../../shared/logger';

export interface AgentAdminServiceDeps {
  agentDefRepo:        AgentDefinitionRepository;
  channelMappingRepo:  ChannelMappingRepository;
  prisma:              PrismaClient;
  logger:              Logger;
}


export type RegisteredToolView = {
  id:            string;
  toolId:        string;
  name:          string;
  description:   string;
  category:      string;
  domain:        string;
  promptSnippet: string | null;
  recoveryHint:  string | null;
  hitlRequired:  boolean;
  guardrails:    string[];
  engines:       string[];
};

export type AgentServiceError =
  | { kind: 'not_found';   message: string }
  | { kind: 'conflict';    message: string }
  | { kind: 'validation';  message: string }
  | { kind: 'internal';    message: string };

type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: AgentServiceError };

function ok<T>(value: T): ServiceResult<T> { return { ok: true,  value }; }
function fail<T>(error: AgentServiceError): ServiceResult<T> { return { ok: false, error }; }

export class AgentAdminService {
  private readonly log: Logger;

  constructor(private readonly deps: AgentAdminServiceDeps) {
    this.log = deps.logger.child({ service: 'agent-admin' });
  }

  // ── Tool registry ─────────────────────────────────────────────────────────

  async listRegisteredTools(): Promise<RegisteredToolView[]> {
    return this.deps.prisma.registeredTool.findMany({
      where:   { deprecated: false },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
  }

  private async validateToolIds(toolIds: string[]): Promise<AgentServiceError | null> {
    if (toolIds.length === 0) return null;
    const tools = await this.deps.prisma.registeredTool.findMany({
      where:  { toolId: { in: toolIds }, deprecated: false },
      select: { toolId: true },
    });
    const validSet = new Set(tools.map(t => t.toolId));
    const invalid  = toolIds.filter(id => !validSet.has(id));
    if (invalid.length > 0) {
      return { kind: 'validation', message: `Unknown or deprecated tool IDs: ${invalid.join(', ')}` };
    }
    return null;
  }

  // ── Agent CRUD ────────────────────────────────────────────────────────────

  async listAgents(companyId: string): Promise<ServiceResult<AgentAdminView[]>> {
    const result = await this.deps.agentDefRepo.adminFindAll(companyId);
    if (!result.ok) return fail({ kind: 'internal', message: 'Failed to load agents' });
    return ok(result.value);
  }

  async getAgent(id: string, companyId: string): Promise<ServiceResult<AgentAdminView>> {
    const result = await this.deps.agentDefRepo.adminFindById(id, companyId);
    if (!result.ok) return fail({ kind: 'internal', message: 'Failed to load agent' });
    if (!result.value) return fail({ kind: 'not_found', message: 'Agent not found' });
    return ok(result.value);
  }

  async createAgent(
    companyId: string,
    input: Omit<CreateAgentInput, 'companyId'>,
  ): Promise<ServiceResult<AgentAdminView>> {
    // Deduplicate tool IDs
    const toolIds = input.toolIds ? [...new Set(input.toolIds)] : [];

    const toolErr = await this.validateToolIds(toolIds);
    if (toolErr) return fail(toolErr);

    // Validate parent
    if (input.parentId) {
      if (input.isRootAgent) {
        return fail({ kind: 'validation', message: 'A root agent cannot have a parent' });
      }
      const parent = await this.deps.agentDefRepo.adminFindById(input.parentId, companyId);
      if (!parent.ok || !parent.value) {
        return fail({ kind: 'validation', message: 'Parent agent not found' });
      }
    }

    const result = await this.deps.agentDefRepo.create({ ...input, companyId, toolIds });
    if (!result.ok) {
      if (this.isUniqueConstraint(result.error)) {
        return fail({ kind: 'conflict', message: 'An agent with this name already exists for this company' });
      }
      this.log.error('agent.create.failed', { error: String(result.error) });
      return fail({ kind: 'internal', message: 'Failed to create agent' });
    }
    return ok(result.value);
  }

  async updateAgent(
    id: string,
    companyId: string,
    input: UpdateAgentInput,
  ): Promise<ServiceResult<AgentAdminView>> {
    const existing = await this.getAgent(id, companyId);
    if (!existing.ok) return existing;

    // Validate tool IDs if being updated
    if (input.toolIds !== undefined) {
      const toolIds = [...new Set(input.toolIds)];
      input = { ...input, toolIds };
      const toolErr = await this.validateToolIds(toolIds);
      if (toolErr) return fail(toolErr);
    }

    // Validate parentId if being changed
    if (input.parentId !== undefined && input.parentId !== null) {
      if (input.parentId === id) {
        return fail({ kind: 'validation', message: 'An agent cannot be its own parent' });
      }

      // Cycle detection: proposed parent must not be a descendant of this agent
      const ancestors = await this.deps.agentDefRepo.ancestorIds(input.parentId);
      if (!ancestors.ok) return fail({ kind: 'internal', message: 'Failed to validate parent' });
      if (ancestors.value.includes(id)) {
        return fail({ kind: 'validation', message: 'Setting this parent would create a cycle' });
      }

      const parent = await this.deps.agentDefRepo.adminFindById(input.parentId, companyId);
      if (!parent.ok || !parent.value) {
        return fail({ kind: 'validation', message: 'Parent agent not found' });
      }
    }

    // If setting as root, clear parent
    if (input.isRootAgent) {
      input = { ...input, parentId: null };
    }

    const result = await this.deps.agentDefRepo.update(id, companyId, input);
    if (!result.ok) {
      if (this.isUniqueConstraint(result.error)) {
        return fail({ kind: 'conflict', message: 'An agent with this name already exists for this company' });
      }
      this.log.error('agent.update.failed', { id, error: String(result.error) });
      return fail({ kind: 'internal', message: 'Failed to update agent' });
    }
    return ok(result.value);
  }

  async deleteAgent(id: string, companyId: string): Promise<ServiceResult<void>> {
    const existing = await this.getAgent(id, companyId);
    if (!existing.ok) return existing as ServiceResult<void>;

    const childCount = await this.deps.agentDefRepo.countChildren(id);
    if (!childCount.ok) return fail({ kind: 'internal', message: 'Failed to check child agents' });
    if (childCount.value > 0) {
      return fail({ kind: 'validation', message: 'Cannot delete an agent that has child agents. Delete or reparent them first.' });
    }

    // Remove all channel mappings pointing to this agent
    await this.deps.prisma.channelAgentMapping.deleteMany({ where: { agentDefinitionId: id } });

    const result = await this.deps.agentDefRepo.delete(id);
    if (!result.ok) {
      this.log.error('agent.delete.failed', { id, error: String(result.error) });
      return fail({ kind: 'internal', message: 'Failed to delete agent' });
    }
    return ok(undefined);
  }

  async toggleActive(id: string, companyId: string): Promise<ServiceResult<AgentAdminView>> {
    const existing = await this.getAgent(id, companyId);
    if (!existing.ok) return existing;

    const result = await this.deps.agentDefRepo.update(id, companyId, {
      isActive: !existing.value.isActive,
    });
    if (!result.ok) return fail({ kind: 'internal', message: 'Failed to toggle agent status' });
    return ok(result.value);
  }

  // ── Channel mappings ──────────────────────────────────────────────────────

  async listMappings(companyId: string): Promise<ServiceResult<ChannelMappingView[]>> {
    const result = await this.deps.channelMappingRepo.list(companyId);
    if (!result.ok) return fail({ kind: 'internal', message: 'Failed to load channel mappings' });
    return ok(result.value);
  }

  async setMapping(input: SetMappingInput): Promise<ServiceResult<ChannelMappingView>> {
    // Verify the target agent exists and belongs to the same company
    const agent = await this.deps.agentDefRepo.adminFindById(input.agentDefinitionId, input.companyId);
    if (!agent.ok) return fail({ kind: 'internal', message: 'Failed to validate agent' });
    if (!agent.value) return fail({ kind: 'not_found', message: 'Agent not found' });

    const result = await this.deps.channelMappingRepo.upsert(input);
    if (!result.ok) return fail({ kind: 'internal', message: 'Failed to save channel mapping' });
    return ok(result.value);
  }

  async removeMapping(
    companyId:         string,
    channelType:       string,
    channelIdentifier: string,
  ): Promise<ServiceResult<void>> {
    const result = await this.deps.channelMappingRepo.remove(companyId, channelType, channelIdentifier);
    if (!result.ok) return fail({ kind: 'internal', message: 'Failed to remove channel mapping' });
    return ok(undefined);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private isUniqueConstraint(e: unknown): boolean {
    return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
  }
}
