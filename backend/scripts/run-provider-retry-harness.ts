import assert from 'node:assert/strict';

import { withProviderRetry } from '../src/utils/provider-retry';

const createStatusError = (
  status: number,
  headers?: Record<string, string>,
  message?: string,
): Error & {
  status: number;
  headers: Record<string, string>;
} => {
  const error = new Error(message ?? `http_${status}`) as Error & {
    status: number;
    headers: Record<string, string>;
  };
  error.status = status;
  error.headers = headers ?? {};
  return error;
};

async function run(): Promise<void> {
  let attempts = 0;
  const google500ThenSuccess = await withProviderRetry('google', async () => {
    attempts += 1;
    if (attempts < 3) {
      throw createStatusError(500, {}, `google_500_${attempts}`);
    }
    return 'ok';
  });
  assert.equal(google500ThenSuccess, 'ok');
  assert.equal(attempts, 3);

  attempts = 0;
  const groqStart = Date.now();
  const groq429ThenSuccess = await withProviderRetry('groq', async () => {
    attempts += 1;
    if (attempts === 1) {
      throw createStatusError(429, { 'retry-after': '1' }, 'groq_rate_limited');
    }
    return 'ok';
  });
  const groqElapsedMs = Date.now() - groqStart;
  assert.equal(groq429ThenSuccess, 'ok');
  assert.equal(attempts, 2);
  assert.ok(groqElapsedMs >= 900, `Expected Retry-After wait >= 900ms, got ${groqElapsedMs}ms`);

  attempts = 0;
  const larkNetworkThenSuccess = await withProviderRetry('lark', async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('ECONNRESET socket hang up');
    }
    return 'ok';
  });
  assert.equal(larkNetworkThenSuccess, 'ok');
  assert.equal(attempts, 2);

  attempts = 0;
  await assert.rejects(
    () =>
      withProviderRetry('google', async () => {
        attempts += 1;
        throw createStatusError(400, {}, 'bad_request');
      }),
    /bad_request/,
  );
  assert.equal(attempts, 1);

  attempts = 0;
  await assert.rejects(
    () =>
      withProviderRetry('google', async () => {
        attempts += 1;
        throw createStatusError(500, {}, 'always_fail');
      }),
    /always_fail/,
  );
  assert.equal(attempts, 3);

  console.log('provider-retry-harness-ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
