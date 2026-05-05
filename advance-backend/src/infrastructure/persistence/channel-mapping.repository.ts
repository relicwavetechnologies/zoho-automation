import type { PrismaClient } from '../../generated/prisma';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { ok, err, type Result } from '../../shared/result';

// ─── View types ───────────────────────────────────────────────────────────────

export interface ChannelMappingView {
  readonly id:                string;
  readonly companyId:         string;
  readonly channelType:       string;
  readonly channelIdentifier: string;
  readonly agentDefinitionId: string;
  readonly isActive:          boolean;
  readonly createdAt:         Date;
  readonly updatedAt:         Date;
  readonly agentDefinition: {
    readonly id:   string;
    readonly name: string;
  };
}

export interface SetMappingInput {
  companyId:         string;
  channelType:       string;
  channelIdentifier: string;
  agentDefinitionId: string;
}

const mappingSelect = {
  id:                true,
  companyId:         true,
  channelType:       true,
  channelIdentifier: true,
  agentDefinitionId: true,
  isActive:          true,
  createdAt:         true,
  updatedAt:         true,
  agentDefinition: {
    select: { id: true, name: true },
  },
} as const;

function mapRow(r: {
  id: string; companyId: string; channelType: string; channelIdentifier: string;
  agentDefinitionId: string; isActive: boolean; createdAt: Date; updatedAt: Date;
  agentDefinition: { id: string; name: string };
}): ChannelMappingView {
  return {
    id:                r.id,
    companyId:         r.companyId,
    channelType:       r.channelType,
    channelIdentifier: r.channelIdentifier,
    agentDefinitionId: r.agentDefinitionId,
    isActive:          r.isActive,
    createdAt:         r.createdAt,
    updatedAt:         r.updatedAt,
    agentDefinition:   r.agentDefinition,
  };
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class ChannelMappingRepository {
  constructor(private readonly db: PrismaClient) {}

  async list(companyId: string): Promise<Result<ChannelMappingView[], InfraError>> {
    try {
      const rows = await this.db.channelAgentMapping.findMany({
        where:   { companyId },
        select:  mappingSelect,
        orderBy: [{ channelType: 'asc' }, { channelIdentifier: 'asc' }],
      });
      return ok(rows.map(mapRow));
    } catch (e) {
      return err(wrapInfra('prisma', 'ChannelMapping.list', e));
    }
  }

  async upsert(input: SetMappingInput): Promise<Result<ChannelMappingView, InfraError>> {
    try {
      const row = await this.db.channelAgentMapping.upsert({
        where: {
          companyId_channelType_channelIdentifier: {
            companyId:         input.companyId,
            channelType:       input.channelType,
            channelIdentifier: input.channelIdentifier,
          },
        },
        create: {
          companyId:         input.companyId,
          channelType:       input.channelType,
          channelIdentifier: input.channelIdentifier,
          agentDefinitionId: input.agentDefinitionId,
          isActive:          true,
        },
        update: {
          agentDefinitionId: input.agentDefinitionId,
          isActive:          true,
        },
        select: mappingSelect,
      });
      return ok(mapRow(row));
    } catch (e) {
      return err(wrapInfra('prisma', 'ChannelMapping.upsert', e));
    }
  }

  async remove(
    companyId:         string,
    channelType:       string,
    channelIdentifier: string,
  ): Promise<Result<void, InfraError>> {
    try {
      await this.db.channelAgentMapping.deleteMany({
        where: { companyId, channelType, channelIdentifier },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'ChannelMapping.remove', e));
    }
  }
}
