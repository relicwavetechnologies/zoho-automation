export const OBSERVABILITY_BOUNDARY = {
  key: 'observability',
  responsibility: 'Structured logs, metrics, retry telemetry, and error classification signals.',
};

export * from './error-classifier';
export * from './retry-policy';
export * from './tracing';
