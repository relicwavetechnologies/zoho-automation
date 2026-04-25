import { generateText, stepCountIs } from 'ai';
import type { AgentRunCtx } from './agent-run-ctx';
import { toAISdkTools } from '../tools/ai-sdk-adapter';
import { LARK_RUNNER_SYSTEM, LARK_TOOL_IDS } from './prompts/lark.prompt';
import {
  runWithCircuitBreaker,
  CircuitBreakerOpenError,
  GEMINI_CIRCUIT_OPTIONS,
} from '../../../shared/circuit-breaker';

export async function runLarkAgent(
  args: { task: string },
  ctx: AgentRunCtx,
): Promise<string> {
  const log = ctx.logger.child({ runner: 'lark' });
  log.info('lark_runner.start', { task: args.task.slice(0, 120) });

  const tools = toAISdkTools(ctx.allTools, {
    runContext: ctx.runContext,
    perm:       ctx.perm,
    logger:     ctx.logger,
    clock:      ctx.clock,
    ...(ctx.approvalGate ? { approvalGate: ctx.approvalGate } : {}),
    ...(ctx.chatId !== undefined ? { chatId: ctx.chatId } : {}),
  }, LARK_TOOL_IDS);

  try {
    const { text } = await runWithCircuitBreaker(
      'gemini', 'lark-runner', GEMINI_CIRCUIT_OPTIONS,
      () => generateText({
        model:       ctx.model,
        system:      LARK_RUNNER_SYSTEM,
        prompt:      args.task,
        tools,
        stopWhen:    [stepCountIs(10)],
        temperature: 0,
        abortSignal: AbortSignal.timeout(60_000),
      }),
      log,
    );
    log.info('lark_runner.done', { replyLength: text.length });
    return text || 'Done.';
  } catch (e) {
    if (e instanceof CircuitBreakerOpenError) {
      log.warn('lark_runner.circuit_open', { retryAt: e.retryAt });
      return 'error: AI service temporarily unavailable, please try again shortly.';
    }
    const msg = e instanceof Error ? e.message : String(e);
    log.error('lark_runner.error', { error: msg });
    return `error: ${msg}`;
  }
}
