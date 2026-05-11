import { generateText, stepCountIs } from 'ai';
import type { AgentRunCtx } from './agent-run-ctx';
import { toAISdkTools } from '../tools/ai-sdk-adapter';
import { GOOGLE_RUNNER_SYSTEM, GOOGLE_TOOL_IDS } from './prompts/google.prompt';
import {
  runWithCircuitBreaker,
  CircuitBreakerOpenError,
  GEMINI_CIRCUIT_OPTIONS,
} from '../../../shared/circuit-breaker';
import { appendToolTrace } from './tool-trace';

export async function runGoogleAgent(
  args: { task: string },
  ctx: AgentRunCtx,
): Promise<string> {
  const log = ctx.logger.child({ runner: 'google' });
  log.info('google_runner.start', { task: args.task.slice(0, 120) });

  const tools = toAISdkTools(ctx.allTools, {
    runContext: ctx.runContext,
    perm:       ctx.perm,
    logger:     ctx.logger,
    clock:      ctx.clock,
    ...(ctx.approvalGate ? { approvalGate: ctx.approvalGate } : {}),
    ...(ctx.chatId !== undefined ? { chatId: ctx.chatId } : {}),
  }, GOOGLE_TOOL_IDS);

  try {
    const { text, steps } = await runWithCircuitBreaker(
      'gemini', 'google-runner', GEMINI_CIRCUIT_OPTIONS,
      () => generateText({
        model:       ctx.model,
        system:      GOOGLE_RUNNER_SYSTEM,
        prompt:      args.task,
        tools,
        stopWhen:    [stepCountIs(10)],
        temperature: 0,
        abortSignal: AbortSignal.timeout(60_000),
      }),
      log,
    );
    const result = appendToolTrace(text || 'Done.', steps);
    log.info('google_runner.done', { replyLength: result.length });
    return result;
  } catch (e) {
    if (e instanceof CircuitBreakerOpenError) {
      log.warn('google_runner.circuit_open', { retryAt: e.retryAt });
      return 'error: AI service temporarily unavailable, please try again shortly.';
    }
    const msg = e instanceof Error ? e.message : String(e);
    log.error('google_runner.error', { error: msg });
    return `error: ${msg}`;
  }
}
