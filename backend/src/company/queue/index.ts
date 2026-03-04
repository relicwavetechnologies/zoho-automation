export const QUEUE_BOUNDARY = {
  key: 'queue',
  responsibility: 'BullMQ queueing, worker lifecycle control, and correlation handling.',
};

export * from './producer';
export * from './runtime';
export * from './workers';
