import { prisma } from '../../utils/prisma';

export type AiModelTargetConfigRow = {
  id: string;
  targetKey: string;
  provider: string;
  modelId: string;
  thinkingLevel: string | null;
  fastProvider: string | null;
  fastModelId: string | null;
  fastThinkingLevel: string | null;
  updatedBy: string;
  updatedAt: Date;
};

class AiModelTargetConfigRepository {
  async listAll(): Promise<AiModelTargetConfigRow[]> {
    return prisma.aiModelTargetConfig.findMany({
      orderBy: { targetKey: 'asc' },
    });
  }

  async findByTargetKey(targetKey: string): Promise<AiModelTargetConfigRow | null> {
    return prisma.aiModelTargetConfig.findUnique({
      where: { targetKey },
    });
  }

  async upsert(input: {
    targetKey: string;
    provider: string;
    modelId: string;
    thinkingLevel?: string | null;
    fastProvider?: string | null;
    fastModelId?: string | null;
    fastThinkingLevel?: string | null;
    updatedBy: string;
  }): Promise<AiModelTargetConfigRow> {
    return prisma.aiModelTargetConfig.upsert({
      where: { targetKey: input.targetKey },
      create: {
        targetKey: input.targetKey,
        provider: input.provider,
        modelId: input.modelId,
        thinkingLevel: input.thinkingLevel ?? null,
        fastProvider: input.fastProvider ?? null,
        fastModelId: input.fastModelId ?? null,
        fastThinkingLevel: input.fastThinkingLevel ?? null,
        updatedBy: input.updatedBy,
      },
      update: {
        provider: input.provider,
        modelId: input.modelId,
        thinkingLevel: input.thinkingLevel ?? null,
        fastProvider: input.fastProvider ?? null,
        fastModelId: input.fastModelId ?? null,
        fastThinkingLevel: input.fastThinkingLevel ?? null,
        updatedBy: input.updatedBy,
      },
    });
  }
}

export const aiModelTargetConfigRepository = new AiModelTargetConfigRepository();
