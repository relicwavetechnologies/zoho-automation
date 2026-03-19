import type { Prisma, RuntimeShadowParityReport } from '../../../generated/prisma';
import { prisma } from '../../../utils/prisma';
import type { RuntimeChannel } from './runtime.types';

const toJsonValue = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;

export class RuntimeShadowParityRepository {
  create(input: {
    conversationId?: string | null;
    runId?: string | null;
    channel: RuntimeChannel;
    baselineEngine: string;
    candidateEngine: string;
    baselineSummary?: string | null;
    candidateSummary?: string | null;
    diffSummary?: string | null;
    metricsJson?: Record<string, unknown> | null;
  }): Promise<RuntimeShadowParityReport> {
    return prisma.runtimeShadowParityReport.create({
      data: {
        conversationId: input.conversationId ?? null,
        runId: input.runId ?? null,
        channel: input.channel,
        baselineEngine: input.baselineEngine,
        candidateEngine: input.candidateEngine,
        baselineSummary: input.baselineSummary ?? null,
        candidateSummary: input.candidateSummary ?? null,
        diffSummary: input.diffSummary ?? null,
        metricsJson: input.metricsJson ? toJsonValue(input.metricsJson) : undefined,
      },
    });
  }
}

export const runtimeShadowParityRepository = new RuntimeShadowParityRepository();

