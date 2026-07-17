import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';
import {
  limitModelFacingResult,
  MODEL_FACING_RESULT_MAX_BYTES,
} from '../../src/application/gateway/model-facing-result-limit';

describe('model-facing gateway result ceiling', () => {
  it('preserves results that already fit', () => {
    const value = { rows: [{ id: 1, name: 'small' }] };
    assert.equal(limitModelFacingResult(value), value);
  });

  it('caps escaped and multibyte JSON with truthful byte metadata', () => {
    const value = {
      rows: Array.from({ length: 2_000 }, (_, index) => ({
        index,
        text: `\"quoted\" ${'₹'.repeat(100)} ${'x'.repeat(100)}`,
      })),
    };

    const limited = limitModelFacingResult(value) as {
      preview: string;
      truncation: {
        truncated: boolean;
        originalBytes: number;
        returnedBytes: number;
        maxBytes: number;
        continuation: { available: boolean };
      };
    };
    const returnedBytes = Buffer.byteLength(JSON.stringify(limited), 'utf8');

    assert.ok(returnedBytes <= MODEL_FACING_RESULT_MAX_BYTES);
    assert.equal(limited.truncation.returnedBytes, returnedBytes);
    assert.ok(limited.truncation.originalBytes > returnedBytes);
    assert.equal(limited.truncation.maxBytes, MODEL_FACING_RESULT_MAX_BYTES);
    assert.equal(limited.truncation.truncated, true);
    assert.equal(limited.truncation.continuation.available, false);
  });

  it('returns a JSON-safe fallback for a circular result instead of the original', () => {
    const circular: { name: string; self?: unknown } = { name: 'circular' };
    circular.self = circular;

    const limited = limitModelFacingResult(circular) as {
      resultUnavailable: boolean;
      error: { code: string };
      valueType: string;
    };

    assert.notEqual(limited, circular);
    assert.doesNotThrow(() => JSON.stringify(limited));
    assert.equal(limited.resultUnavailable, true);
    assert.equal(limited.error.code, 'result_serialization_failed');
    assert.equal(limited.valueType, 'object');
  });

  it('returns a JSON-safe fallback for a BigInt result instead of the original', () => {
    const original = { total: 9_007_199_254_740_993n };

    const limited = limitModelFacingResult(original) as {
      resultUnavailable: boolean;
      error: { code: string };
      valueType: string;
    };

    assert.notEqual(limited, original);
    assert.doesNotThrow(() => JSON.stringify(limited));
    assert.equal(limited.resultUnavailable, true);
    assert.equal(limited.error.code, 'result_serialization_failed');
    assert.equal(limited.valueType, 'object');
  });
});
