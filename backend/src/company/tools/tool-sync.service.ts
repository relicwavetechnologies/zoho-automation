import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { TOOL_REGISTRY } from './tool-registry';

export const syncToolRegistry = async (): Promise<void> => {
  let upsertedCount = 0;

  for (const tool of TOOL_REGISTRY) {
    await prisma.registeredTool.upsert({
      where: { toolId: tool.id },
      create: {
        toolId: tool.id,
        name: tool.name,
        description: tool.description,
        category: tool.category,
        domain: tool.domain,
        promptSnippet: tool.promptSnippet ?? null,
        recoveryHint: tool.recoveryHint ?? null,
        hitlRequired: tool.hitlRequired ?? false,
        guardrails: tool.guardrails ?? [],
        deprecated: tool.deprecated ?? false,
        engines: tool.engines,
      },
      update: {
        name: tool.name,
        description: tool.description,
        promptSnippet: tool.promptSnippet ?? null,
        recoveryHint: tool.recoveryHint ?? null,
        hitlRequired: tool.hitlRequired ?? false,
        guardrails: tool.guardrails ?? [],
        deprecated: tool.deprecated ?? false,
        engines: tool.engines,
      },
    });
    upsertedCount += 1;
  }

  const deprecatedResult = await prisma.registeredTool.updateMany({
    where: {
      toolId: {
        notIn: TOOL_REGISTRY.map((tool) => tool.id),
      },
      deprecated: false,
    },
    data: {
      deprecated: true,
    },
  });

  logger.info('tools.registry.sync.complete', {
    upsertedCount,
    markedDeprecatedCount: deprecatedResult.count,
  });
};
