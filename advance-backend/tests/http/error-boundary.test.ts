import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Response } from 'express';
import { createErrorBoundary } from '../../src/http/error-boundary';
import type { Logger } from '../../src/shared/logger';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

function responseHarness(): {
  response: Response;
  statusCode: () => number | undefined;
  body: () => unknown;
} {
  let capturedStatus: number | undefined;
  let capturedBody: unknown;
  const response = {
    status(code: number) {
      capturedStatus = code;
      return response;
    },
    json(value: unknown) {
      capturedBody = value;
      return response;
    },
  } as unknown as Response;
  return {
    response,
    statusCode: () => capturedStatus,
    body: () => capturedBody,
  };
}

describe('HTTP error boundary', () => {
  it('preserves body-parser payload-too-large failures as OpenAI-compatible HTTP 413 JSON', () => {
    const error = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
      statusCode: 413,
    });
    const captured = responseHarness();

    createErrorBoundary(noopLogger)(error, {} as never, captured.response, () => {});

    assert.equal(captured.statusCode(), 413);
    assert.deepEqual(captured.body(), {
      error: {
        message: 'Request body is too large. Retry with narrower, paginated, or truncated tool results.',
        type: 'request_too_large',
        code: 'payload_too_large',
      },
    });
  });

  it('keeps unrelated unhandled errors on the existing generic 500 path', () => {
    const captured = responseHarness();

    createErrorBoundary(noopLogger)(new Error('boom'), {} as never, captured.response, () => {});

    assert.equal(captured.statusCode(), 500);
    assert.deepEqual(captured.body(), {
      error: 'internal_error',
      message: 'An unexpected error occurred',
    });
  });
});
