import { Buffer } from 'node:buffer';

export const MODEL_FACING_RESULT_MAX_BYTES = 96 * 1024;
export const LOCAL_FILE_RESULT_MAX_BYTES = 8 * 1024 * 1024;

export interface ModelFacingResultTruncation {
  readonly truncated: true;
  readonly reason: 'model_result_limit' | 'local_file_result_limit';
  readonly originalBytes: number;
  readonly returnedBytes: number;
  readonly maxBytes: number;
  readonly previewFormat: 'json_prefix';
  readonly continuation: {
    readonly available: false;
  };
}

/**
 * Final backend-owned guardrail for data returned to the model-facing gateway.
 * Product adapters should preserve useful structure first; this ceiling is the
 * invariant that prevents any governed tool from returning an unbounded value.
 */
export function limitModelFacingResult(
  value: unknown,
  maxBytes = MODEL_FACING_RESULT_MAX_BYTES,
): unknown {
  return limitSerializedResult(value, maxBytes, 'model_result_limit');
}

export function limitLocalFileResult(
  value: unknown,
  maxBytes = LOCAL_FILE_RESULT_MAX_BYTES,
): unknown {
  return limitSerializedResult(value, maxBytes, 'local_file_result_limit');
}

function limitSerializedResult(
  value: unknown,
  maxBytes: number,
  reason: 'model_result_limit' | 'local_file_result_limit',
): unknown {
  const serialization = serializeForModelFacing(value);
  const serialized = serialization.serialized;
  const originalBytes = byteLength(serialized);
  if (originalBytes <= maxBytes) return serialization.value;

  const metadataWithoutReturnedBytes = {
    truncated: true as const,
    reason,
    originalBytes,
    returnedBytes: 0,
    maxBytes,
    previewFormat: 'json_prefix' as const,
    continuation: { available: false as const },
  };

  let low = 0;
  let high = serialized.length;
  let best = buildLimitedResult('', metadataWithoutReturnedBytes);

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = buildLimitedResult(serialized.slice(0, middle), metadataWithoutReturnedBytes);
    if (byteLength(JSON.stringify(candidate)) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  let preview = best.preview;
  let returnedBytes = 0;
  while (true) {
    const candidate = buildLimitedResult(preview, {
      ...metadataWithoutReturnedBytes,
      returnedBytes,
    });
    const actualBytes = byteLength(JSON.stringify(candidate));
    if (actualBytes > maxBytes && preview.length > 0) {
      preview = preview.slice(0, -1);
      returnedBytes = 0;
      continue;
    }
    if (actualBytes === returnedBytes) return candidate;
    returnedBytes = actualBytes;
  }
}

function buildLimitedResult(
  preview: string,
  truncation: ModelFacingResultTruncation,
): { preview: string; truncation: ModelFacingResultTruncation } {
  return { preview, truncation };
}

function serializeForModelFacing(value: unknown): { serialized: string; value: unknown } {
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return { serialized, value };
  } catch {
    // Fall through to the fixed JSON-safe result below. Returning the original
    // here would bypass the gateway ceiling for circular objects and BigInt.
  }

  const fallback = {
    resultUnavailable: true,
    error: {
      code: 'result_serialization_failed',
      message: 'The tool result could not be serialized as JSON.',
    },
    valueType: describeValueType(value),
  } as const;
  return { serialized: JSON.stringify(fallback), value: fallback };
}

function describeValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
