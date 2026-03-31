import type { Prisma } from '../../../generated/prisma';
import { prisma } from '../../../utils/prisma';

type WriteStepResultInput = {
  executionId: string;
  sequence: number;
  toolName: string;
  actorKey?: string | null;
  title?: string | null;
  success: boolean;
  status?: string | null;
  authorityLevel?: string | null;
  resolvedIds?: Record<string, unknown> | null;
  entityIndexes?: Record<string, unknown> | null;
  summary?: string | null;
  rawOutput?: Record<string, unknown> | null;
};

export type StepResultRow = Prisma.StepResultGetPayload<Record<string, never>>;

const toJsonValue = (value: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined =>
  value == null ? undefined : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);

export class StepResultRepository {
  writeStepResult(input: WriteStepResultInput): Promise<StepResultRow> {
    return prisma.stepResult.create({
      data: {
        executionId: input.executionId,
        sequence: input.sequence,
        toolName: input.toolName,
        actorKey: input.actorKey ?? null,
        title: input.title ?? null,
        success: input.success,
        status: input.status ?? null,
        authorityLevel: input.authorityLevel ?? null,
        resolvedIds: toJsonValue(input.resolvedIds),
        entityIndexes: toJsonValue(input.entityIndexes),
        summary: input.summary ?? null,
        rawOutput: toJsonValue(input.rawOutput),
      },
    });
  }

  listStepResults(executionId: string): Promise<StepResultRow[]> {
    return prisma.stepResult.findMany({
      where: { executionId },
      orderBy: [
        { sequence: 'asc' },
        { createdAt: 'asc' },
      ],
    });
  }
}

export const stepResultRepository = new StepResultRepository();
