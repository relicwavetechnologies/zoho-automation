import type { Logger } from '../../../shared/logger';

export interface ShadowRunResult {
  readonly text: string;
  readonly toolsCalled: readonly string[];
  readonly latencyMs?: number;
}

export interface ShadowRunner<Input> {
  run(input: Input): Promise<ShadowRunResult>;
}

export async function runWithShadowParity<Input>(
  input: Input,
  primary: ShadowRunner<Input>,
  shadow: ShadowRunner<Input>,
  logger: Logger,
): Promise<ShadowRunResult> {
  const primaryStartedAt = Date.now();
  const primaryPromise = primary.run(input).then(result => ({
    ...result,
    latencyMs: result.latencyMs ?? Date.now() - primaryStartedAt,
  }));

  const shadowStartedAt = Date.now();
  const shadowPromise = shadow.run(input)
    .then(result => ({
      ...result,
      latencyMs: result.latencyMs ?? Date.now() - shadowStartedAt,
    }))
    .catch(error => ({
      text: '',
      toolsCalled: [],
      latencyMs: Date.now() - shadowStartedAt,
      error: error instanceof Error ? error.message : String(error),
    }));

  const [primaryResult, shadowResult] = await Promise.all([primaryPromise, shadowPromise]);
  logger.info('dynamic_graph.shadow_parity', {
    primaryLatencyMs: primaryResult.latencyMs,
    shadowLatencyMs: shadowResult.latencyMs,
    primaryToolCalls: primaryResult.toolsCalled,
    shadowToolCalls: shadowResult.toolsCalled,
    resultMatch: 'error' in shadowResult ? false : primaryResult.text === shadowResult.text,
    primaryLength: primaryResult.text.length,
    shadowLength: shadowResult.text.length,
    ...('error' in shadowResult ? { shadowError: shadowResult.error } : {}),
  });

  return primaryResult;
}
