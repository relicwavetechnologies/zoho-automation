import { Prisma, type RuntimeRun, type RuntimeSnapshot } from '../../../generated/prisma';
import { prisma } from '../../../utils/prisma';
import type { RuntimeChannel, RuntimeRunEntrypoint, RuntimeRunStatus } from './runtime.types';

const toJsonValue = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;

export class RuntimeRunRepository {
  create(input: {
    conversationId: string;
    parentRunId?: string | null;
    engine?: string;
    engineMode?: 'primary' | 'shadow';
    channel: RuntimeChannel;
    entrypoint: RuntimeRunEntrypoint;
    currentNode?: string | null;
    maxSteps?: number;
    traceJson?: Record<string, unknown> | null;
    metadataJson?: Record<string, unknown> | null;
  }): Promise<RuntimeRun> {
    return prisma.runtimeRun.create({
      data: {
        conversationId: input.conversationId,
        parentRunId: input.parentRunId ?? null,
        engine: input.engine ?? 'langgraph',
        engineMode: input.engineMode ?? 'primary',
        channel: input.channel,
        entrypoint: input.entrypoint,
        currentNode: input.currentNode ?? 'load_run_context',
        maxSteps: input.maxSteps ?? 12,
        traceJson: input.traceJson ? toJsonValue(input.traceJson) : undefined,
        metadataJson: input.metadataJson ? toJsonValue(input.metadataJson) : undefined,
      },
    });
  }

  getById(id: string): Promise<RuntimeRun | null> {
    return prisma.runtimeRun.findUnique({ where: { id } });
  }

  update(runId: string, input: {
    status?: RuntimeRunStatus;
    currentNode?: string | null;
    stepCount?: number;
    stopReason?: string | null;
    finishedAt?: Date | null;
    errorJson?: Record<string, unknown> | null;
    traceJson?: Record<string, unknown> | null;
    metadataJson?: Record<string, unknown> | null;
  }): Promise<RuntimeRun> {
    return prisma.runtimeRun.update({
      where: { id: runId },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.currentNode !== undefined ? { currentNode: input.currentNode } : {}),
        ...(input.stepCount !== undefined ? { stepCount: input.stepCount } : {}),
        ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
        ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
        ...(input.errorJson !== undefined
          ? { errorJson: input.errorJson ? toJsonValue(input.errorJson) : Prisma.JsonNull }
          : {}),
        ...(input.traceJson !== undefined
          ? { traceJson: input.traceJson ? toJsonValue(input.traceJson) : Prisma.JsonNull }
          : {}),
        ...(input.metadataJson !== undefined
          ? { metadataJson: input.metadataJson ? toJsonValue(input.metadataJson) : Prisma.JsonNull }
          : {}),
      },
    });
  }

  createSnapshot(input: {
    runId: string;
    stepIndex: number;
    nodeName: string;
    stateJson: Record<string, unknown>;
  }): Promise<RuntimeSnapshot> {
    return prisma.runtimeSnapshot.create({
      data: {
        runId: input.runId,
        stepIndex: input.stepIndex,
        nodeName: input.nodeName,
        stateJson: toJsonValue(input.stateJson),
      },
    });
  }

  listSnapshots(runId: string): Promise<RuntimeSnapshot[]> {
    return prisma.runtimeSnapshot.findMany({
      where: { runId },
      orderBy: [
        { stepIndex: 'asc' },
        { createdAt: 'asc' },
      ],
    });
  }
}

export const runtimeRunRepository = new RuntimeRunRepository();
