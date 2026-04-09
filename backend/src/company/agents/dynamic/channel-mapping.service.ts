import type { AgentDefinition, ChannelAgentMapping } from '../../../generated/prisma';
import { HttpException } from '../../../core/http-exception';
import { prisma } from '../../../utils/prisma';

class ChannelMappingService {
  async setMapping(input: {
    companyId: string;
    channelType: 'lark' | 'desktop';
    channelIdentifier: string;
    agentDefinitionId: string;
  }): Promise<ChannelAgentMapping> {
    const agent = await prisma.agentDefinition.findFirst({
      where: {
        id: input.agentDefinitionId,
        companyId: input.companyId,
      },
      select: {
        id: true,
      },
    });

    if (!agent) {
      throw new HttpException(404, 'Mapped agent not found');
    }

    return prisma.channelAgentMapping.upsert({
      where: {
        companyId_channelType_channelIdentifier: {
          companyId: input.companyId,
          channelType: input.channelType,
          channelIdentifier: input.channelIdentifier.trim(),
        },
      },
      create: {
        companyId: input.companyId,
        channelType: input.channelType,
        channelIdentifier: input.channelIdentifier.trim(),
        agentDefinitionId: input.agentDefinitionId,
      },
      update: {
        agentDefinitionId: input.agentDefinitionId,
        isActive: true,
      },
    });
  }

  async removeMapping(
    companyId: string,
    channelType: string,
    channelIdentifier: string,
  ): Promise<void> {
    await prisma.channelAgentMapping.deleteMany({
      where: {
        companyId,
        channelType: channelType.trim(),
        channelIdentifier: channelIdentifier.trim(),
      },
    });
  }

  async resolveAgent(
    companyId: string,
    channelType: string,
    channelIdentifier: string,
  ): Promise<AgentDefinition | null> {
    const exact = await prisma.channelAgentMapping.findFirst({
      where: {
        companyId,
        channelType: channelType.trim(),
        channelIdentifier: channelIdentifier.trim(),
        isActive: true,
      },
      include: {
        agentDefinition: true,
      },
    });

    if (exact?.agentDefinition) {
      return exact.agentDefinition;
    }

    const wildcard = await prisma.channelAgentMapping.findFirst({
      where: {
        companyId,
        channelType: channelType.trim(),
        channelIdentifier: '*',
        isActive: true,
      },
      include: {
        agentDefinition: true,
      },
    });

    return wildcard?.agentDefinition ?? null;
  }

  async listMappings(companyId: string): Promise<ChannelAgentMapping[]> {
    return prisma.channelAgentMapping.findMany({
      where: {
        companyId,
      },
      include: {
        agentDefinition: true,
      },
      orderBy: [
        { channelType: 'asc' },
        { channelIdentifier: 'asc' },
      ],
    });
  }
}

export const channelMappingService = new ChannelMappingService();
