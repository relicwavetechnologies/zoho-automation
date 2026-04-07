import { HttpException } from '../../../core/http-exception';
import { logger } from '../../../utils/logger';
import { ORCHESTRATION_JOB_NAME, type OrchestrationJobLike, type OrchestrationJobData } from './orchestration.job';

const MEMORY_QUEUE_MAX_PENDING_JOBS = 40;
const MEMORY_QUEUE_CONCURRENCY = 1;

type PendingJobRecord = OrchestrationJobLike & {
  runAt: number;
  enqueuedAt: number;
  timer: NodeJS.Timeout | null;
};

class InMemoryOrchestrationQueue {
  private readonly pendingJobs = new Map<string, PendingJobRecord>();

  private readonly activeJobs = new Map<string, OrchestrationJobLike>();

  private processor: ((job: OrchestrationJobLike) => Promise<void>) | null = null;

  private started = false;

  private draining = false;

  start(processor: (job: OrchestrationJobLike) => Promise<void>): void {
    this.processor = processor;
    this.started = true;
    void this.drain();
  }

  stop(): void {
    for (const job of this.pendingJobs.values()) {
      if (job.timer) {
        clearTimeout(job.timer);
      }
    }
    this.pendingJobs.clear();
    this.activeJobs.clear();
    this.processor = null;
    this.started = false;
    this.draining = false;
  }

  enqueue(input: {
    jobId: string;
    data: OrchestrationJobData;
    delayMs?: number;
  }): string {
    const totalQueued = this.pendingJobs.size + this.activeJobs.size;
    if (!this.pendingJobs.has(input.jobId) && totalQueued >= MEMORY_QUEUE_MAX_PENDING_JOBS) {
      throw new HttpException(503, 'Orchestration fallback queue is full');
    }

    const existing = this.pendingJobs.get(input.jobId);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    const runAt = Date.now() + Math.max(0, input.delayMs ?? 0);
    const job: PendingJobRecord = {
      id: input.jobId,
      name: ORCHESTRATION_JOB_NAME,
      data: input.data,
      runAt,
      enqueuedAt: Date.now(),
      timer: null,
    };
    this.pendingJobs.set(input.jobId, job);
    this.armJob(job);
    return input.jobId;
  }

  remove(jobId: string): boolean {
    const job = this.pendingJobs.get(jobId);
    if (!job) {
      return false;
    }
    if (job.timer) {
      clearTimeout(job.timer);
    }
    this.pendingJobs.delete(jobId);
    return true;
  }

  getSnapshot(): {
    pendingCount: number;
    activeCount: number;
    maxPending: number;
  } {
    return {
      pendingCount: this.pendingJobs.size,
      activeCount: this.activeJobs.size,
      maxPending: MEMORY_QUEUE_MAX_PENDING_JOBS,
    };
  }

  private armJob(job: PendingJobRecord): void {
    const delayMs = Math.max(0, job.runAt - Date.now());
    job.timer = setTimeout(() => {
      job.timer = null;
      void this.drain();
    }, delayMs);
  }

  private getNextReadyJob(): PendingJobRecord | null {
    const now = Date.now();
    const readyJobs = [...this.pendingJobs.values()]
      .filter((job) => job.runAt <= now)
      .sort((a, b) => (a.runAt === b.runAt ? a.enqueuedAt - b.enqueuedAt : a.runAt - b.runAt));
    return readyJobs[0] ?? null;
  }

  private async drain(): Promise<void> {
    if (!this.started || !this.processor || this.draining) {
      return;
    }

    this.draining = true;
    try {
      while (this.started && this.processor && this.activeJobs.size < MEMORY_QUEUE_CONCURRENCY) {
        const nextJob = this.getNextReadyJob();
        if (!nextJob) {
          break;
        }
        this.pendingJobs.delete(String(nextJob.id));
        if (nextJob.timer) {
          clearTimeout(nextJob.timer);
        }
        this.activeJobs.set(String(nextJob.id), nextJob);
        try {
          await this.processor(nextJob);
        } catch (error) {
          logger.error('queue.memory.processor_failed', {
            jobId: nextJob.id,
            taskId: nextJob.data.taskId,
            messageId: nextJob.data.message.messageId,
            error,
          });
        } finally {
          this.activeJobs.delete(String(nextJob.id));
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

const queue = new InMemoryOrchestrationQueue();

export const startInMemoryOrchestrationQueue = (
  processor: (job: OrchestrationJobLike) => Promise<void>,
): void => {
  queue.start(processor);
};

export const stopInMemoryOrchestrationQueue = (): void => {
  queue.stop();
};

export const enqueueInMemoryOrchestrationJob = (input: {
  jobId: string;
  data: OrchestrationJobData;
  delayMs?: number;
}): string => queue.enqueue(input);

export const removeInMemoryOrchestrationJob = (jobId: string): boolean => queue.remove(jobId);

export const getInMemoryOrchestrationQueueSnapshot = (): {
  pendingCount: number;
  activeCount: number;
  maxPending: number;
} => queue.getSnapshot();
