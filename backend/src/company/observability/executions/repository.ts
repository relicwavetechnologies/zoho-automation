import type { Prisma } from '../../../generated/prisma';
import { prisma } from '../../../utils/prisma';

import type {
  AppendExecutionEventInput,
  CancelExecutionRunInput,
  CompleteExecutionRunInput,
  FailExecutionRunInput,
  StartExecutionRunInput,
} from './types';

const runInclude = {
  company: {
    select: {
      id: true,
      name: true,
    },
  },
  user: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
  _count: {
    select: {
      events: true,
    },
  },
} satisfies Prisma.ExecutionRunInclude;

export type ExecutionRunRow = Prisma.ExecutionRunGetPayload<{ include: typeof runInclude }>;
export type ExecutionEventRow = Prisma.ExecutionEventGetPayload<Record<string, never>>;
const insightEventSelect = {
  id: true,
  eventType: true,
  payload: true,
  execution: {
    select: {
      userId: true,
      channel: true,
    },
  },
} satisfies Prisma.ExecutionEventSelect;
export type ExecutionInsightEventRow = Prisma.ExecutionEventGetPayload<{ select: typeof insightEventSelect }>;

export class ExecutionRepository {
  findById(id: string): Promise<ExecutionRunRow | null> {
    return prisma.executionRun.findUnique({
      where: { id },
      include: runInclude,
    });
  }

  findByRequestId(requestId: string): Promise<ExecutionRunRow | null> {
    return prisma.executionRun.findUnique({
      where: { requestId },
      include: runInclude,
    });
  }

  createRun(input: StartExecutionRunInput): Promise<ExecutionRunRow> {
    return prisma.executionRun.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        companyId: input.companyId,
        userId: input.userId ?? null,
        channel: input.channel,
        entrypoint: input.entrypoint,
        requestId: input.requestId ?? null,
        taskId: input.taskId ?? null,
        threadId: input.threadId ?? null,
        chatId: input.chatId ?? null,
        messageId: input.messageId ?? null,
        mode: input.mode ?? null,
        agentTarget: input.agentTarget ?? null,
        latestSummary: input.latestSummary ?? null,
      },
      include: runInclude,
    });
  }

  updateRun(
    executionId: string,
    data: Prisma.ExecutionRunUpdateInput,
  ): Promise<ExecutionRunRow> {
    return prisma.executionRun.update({
      where: { id: executionId },
      data,
      include: runInclude,
    });
  }

  appendEvent(input: AppendExecutionEventInput): Promise<ExecutionEventRow> {
    const payload =
      input.payload == null
        ? undefined
        : (JSON.parse(JSON.stringify(input.payload)) as Prisma.InputJsonValue);

    return prisma.$transaction(
      async (tx) => {
        const updatedRun = await tx.executionRun.update({
          where: { id: input.executionId },
          data: {
            lastSequence: { increment: 1 },
            ...(input.summary ? { latestSummary: input.summary } : {}),
          },
          select: { id: true, lastSequence: true },
        });

        return tx.executionEvent.create({
          data: {
            executionId: input.executionId,
            sequence: updatedRun.lastSequence,
            phase: input.phase,
            eventType: input.eventType,
            actorType: input.actorType,
            actorKey: input.actorKey ?? null,
            title: input.title,
            summary: input.summary ?? null,
            status: input.status ?? null,
            payload,
          },
        });
      },
      {
        maxWait: 10_000,
        timeout: 20_000,
      },
    );
  }

  completeRun(input: CompleteExecutionRunInput): Promise<ExecutionRunRow> {
    return this.updateRun(input.executionId, {
      status: 'completed',
      latestSummary: input.latestSummary ?? undefined,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      finishedAt: new Date(),
    });
  }

  failRun(input: FailExecutionRunInput): Promise<ExecutionRunRow> {
    return this.updateRun(input.executionId, {
      status: 'failed',
      latestSummary: input.latestSummary ?? undefined,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      finishedAt: new Date(),
    });
  }

  cancelRun(input: CancelExecutionRunInput): Promise<ExecutionRunRow> {
    return this.updateRun(input.executionId, {
      status: 'cancelled',
      latestSummary: input.latestSummary ?? undefined,
      finishedAt: new Date(),
    });
  }

  listRuns(input: {
    where: Prisma.ExecutionRunWhereInput;
    page: number;
    pageSize: number;
  }): Promise<ExecutionRunRow[]> {
    return prisma.executionRun.findMany({
      where: input.where,
      include: runInclude,
      orderBy: [
        { startedAt: 'desc' },
        { id: 'desc' },
      ],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    });
  }

  countRuns(where: Prisma.ExecutionRunWhereInput): Promise<number> {
    return prisma.executionRun.count({ where });
  }

  groupRuns(where: Prisma.ExecutionRunWhereInput, by: Array<'status' | 'channel' | 'mode'>) {
    return prisma.executionRun.groupBy({
      by,
      where,
      _count: {
        _all: true,
      },
    });
  }

  listEvents(input: {
    where: Prisma.ExecutionEventWhereInput;
    phase?: string;
    actorType?: string;
  }): Promise<ExecutionEventRow[]> {
    return prisma.executionEvent.findMany({
      where: {
        ...input.where,
        ...(input.phase ? { phase: input.phase } : {}),
        ...(input.actorType ? { actorType: input.actorType } : {}),
      },
      orderBy: [
        { sequence: 'asc' },
        { createdAt: 'asc' },
      ],
    });
  }

  listInsightEvents(input: {
    runWhere: Prisma.ExecutionRunWhereInput;
    eventTypes: string[];
  }): Promise<ExecutionInsightEventRow[]> {
    return prisma.executionEvent.findMany({
      where: {
        eventType: { in: input.eventTypes },
        execution: input.runWhere,
      },
      select: insightEventSelect,
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
    });
  }
}

export const executionRepository = new ExecutionRepository();
