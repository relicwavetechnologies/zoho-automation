import type { AgentDefinition } from '../../../generated/prisma';
import { HttpException } from '../../../core/http-exception';
import { prisma } from '../../../utils/prisma';
import { TOOL_REGISTRY_MAP } from '../../tools/tool-registry';

const agentTreeInclude = {
  parent: true,
  children: {
    include: {
      parent: true,
    },
  },
} as const;

class AgentDefinitionService {
  private async assertToolIdsExist(toolIds: string[]): Promise<void> {
    const invalid = toolIds.filter((toolId) => !TOOL_REGISTRY_MAP.has(toolId));
    if (invalid.length > 0) {
      throw new HttpException(400, `Unknown toolIds: ${invalid.join(', ')}`);
    }
  }

  private async assertParentAllowed(input: {
    companyId: string;
    parentId?: string | null;
    currentAgentId?: string;
  }): Promise<void> {
    if (!input.parentId) {
      return;
    }

    if (input.currentAgentId && input.parentId === input.currentAgentId) {
      throw new HttpException(400, 'An agent cannot be its own parent');
    }

    const parent = await prisma.agentDefinition.findFirst({
      where: {
        id: input.parentId,
        companyId: input.companyId,
      },
      select: {
        id: true,
        parentId: true,
      },
    });

    if (!parent) {
      throw new HttpException(404, 'Parent agent not found');
    }

    if (!input.currentAgentId) {
      return;
    }

    let cursor = parent.parentId;
    while (cursor) {
      if (cursor === input.currentAgentId) {
        throw new HttpException(400, 'Agent parent cannot create a cycle');
      }
      const next = await prisma.agentDefinition.findFirst({
        where: {
          id: cursor,
          companyId: input.companyId,
        },
        select: {
          parentId: true,
        },
      });
      cursor = next?.parentId ?? null;
    }
  }

  async createAgent(input: {
    companyId: string;
    name: string;
    description?: string;
    systemPrompt: string;
    isRootAgent?: boolean;
    toolIds?: string[];
    modelId?: string | null;
    provider?: string | null;
    parentId?: string;
  }): Promise<AgentDefinition> {
    const toolIds = Array.from(new Set(input.toolIds ?? []));
    await this.assertToolIdsExist(toolIds);
    const parentId = input.isRootAgent ? undefined : input.parentId;
    await this.assertParentAllowed({ companyId: input.companyId, parentId });

    try {
      return await prisma.agentDefinition.create({
        data: {
          companyId: input.companyId,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          systemPrompt: input.systemPrompt.trim(),
          isRootAgent: input.isRootAgent ?? false,
          toolIds,
          modelId: input.modelId?.trim() || null,
          provider: input.provider?.trim() || null,
          parentId: input.isRootAgent ? null : parentId ?? null,
        },
      });
    } catch (error: unknown) {
      if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
        throw new HttpException(409, 'An agent with this name already exists for the company');
      }
      throw error;
    }
  }

  async updateAgent(
    id: string,
    companyId: string,
    input: Partial<{
      name: string;
      description: string;
      systemPrompt: string;
      isRootAgent: boolean;
      isActive: boolean;
      toolIds: string[];
      modelId: string | null;
      provider: string | null;
      parentId: string | null;
    }>,
  ): Promise<AgentDefinition> {
    await this.getAgent(id, companyId);
    const toolIds = input.toolIds ? Array.from(new Set(input.toolIds)) : undefined;
    if (toolIds) {
      await this.assertToolIdsExist(toolIds);
    }

    const nextParentId = input.isRootAgent
      ? null
      : input.parentId === undefined
        ? undefined
        : input.parentId;
    await this.assertParentAllowed({
      companyId,
      currentAgentId: id,
      parentId: nextParentId,
    });

    try {
      return await prisma.agentDefinition.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
          ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt.trim() } : {}),
          ...(input.isRootAgent !== undefined ? { isRootAgent: input.isRootAgent } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(toolIds !== undefined ? { toolIds } : {}),
          ...(input.modelId !== undefined ? { modelId: input.modelId?.trim() || null } : {}),
          ...(input.provider !== undefined ? { provider: input.provider?.trim() || null } : {}),
          ...(nextParentId !== undefined ? { parentId: nextParentId } : {}),
        },
      });
    } catch (error: unknown) {
      if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
        throw new HttpException(409, 'An agent with this name already exists for the company');
      }
      throw error;
    }
  }

  async deleteAgent(id: string, companyId: string): Promise<void> {
    const existing = await prisma.agentDefinition.findFirst({
      where: {
        id,
        companyId,
      },
      include: {
        children: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!existing) {
      throw new HttpException(404, 'Agent not found');
    }

    if (existing.children.length > 0) {
      throw new HttpException(400, 'Remove child agents first before deleting this agent.');
    }

    await prisma.channelAgentMapping.deleteMany({
      where: {
        companyId,
        agentDefinitionId: id,
      },
    });

    await prisma.agentDefinition.delete({
      where: {
        id,
      },
    });
  }

  async getAgent(id: string, companyId: string): Promise<AgentDefinition> {
    const agent = await prisma.agentDefinition.findFirst({
      where: {
        id,
        companyId,
      },
      include: agentTreeInclude,
    });

    if (!agent) {
      throw new HttpException(404, 'Agent not found');
    }

    return agent;
  }

  async listAgents(companyId: string): Promise<AgentDefinition[]> {
    return prisma.agentDefinition.findMany({
      where: {
        companyId,
      },
      include: agentTreeInclude,
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  async toggleActive(id: string, companyId: string): Promise<AgentDefinition> {
    const existing = await this.getAgent(id, companyId);
    return prisma.agentDefinition.update({
      where: {
        id,
      },
      data: {
        isActive: !existing.isActive,
      },
    });
  }
}

export const agentDefinitionService = new AgentDefinitionService();
