import type { ErrorDTO } from '../contracts';
import { HttpException } from '../../core/http-exception';

type CandidateError = Error & {
  code?: string;
};

const hasErrorDtoShape = (value: unknown): value is ErrorDTO => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<ErrorDTO>;
  return (
    typeof candidate.type === 'string' &&
    typeof candidate.classifiedReason === 'string' &&
    typeof candidate.retriable === 'boolean'
  );
};

export const classifyRuntimeError = (error: unknown): ErrorDTO => {
  if (hasErrorDtoShape(error)) {
    return error;
  }

  if (error instanceof HttpException) {
    return {
      type: error.status >= 500 ? 'API_ERROR' : 'TOOL_ERROR',
      classifiedReason: `http_${error.status}`,
      rawMessage: error.message,
      retriable: error.status >= 500,
    };
  }

  const candidate = error as CandidateError | undefined;
  const message = candidate?.message ?? String(error ?? 'unknown_error');
  const lowered = message.toLowerCase();

  if (lowered.includes('timeout') || lowered.includes('econn') || lowered.includes('network')) {
    return {
      type: 'API_ERROR',
      classifiedReason: 'network_or_timeout',
      rawMessage: message,
      retriable: true,
    };
  }

  if (lowered.includes('unauthorized') || lowered.includes('forbidden') || lowered.includes('signature')) {
    return {
      type: 'SECURITY_ERROR',
      classifiedReason: 'auth_or_signature_failure',
      rawMessage: message,
      retriable: false,
    };
  }

  if (lowered.includes('not registered') || lowered.includes('not found')) {
    return {
      type: 'TOOL_ERROR',
      classifiedReason: 'missing_runtime_dependency',
      rawMessage: message,
      retriable: false,
    };
  }

  return {
    type: 'UNKNOWN_ERROR',
    classifiedReason: 'unclassified_runtime_error',
    rawMessage: message,
    retriable: false,
  };
};
