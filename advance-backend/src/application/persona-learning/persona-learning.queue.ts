import { Queue } from 'bullmq';

export const PERSONA_LEARNING_QUEUE_NAME = 'persona-learning';

export interface PersonaLearningQueuePayload {
  readonly personaLearningJobId: string;
}

export class PersonaLearningQueue {
  private readonly queue: Queue<PersonaLearningQueuePayload>;

  constructor(redisUrl: string, queueName = PERSONA_LEARNING_QUEUE_NAME) {
    this.queue = new Queue<PersonaLearningQueuePayload>(queueName, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 500 },
      },
    });
  }

  async enqueue(payload: PersonaLearningQueuePayload): Promise<string> {
    const job = await this.queue.add('shadow-extract', payload, {
      // Stable job ID makes re-enqueue/reconciliation idempotent.
      jobId: `persona_learning_${payload.personaLearningJobId}`,
    });
    return job.id ?? '';
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
