import { generateText, stepCountIs } from 'ai';
import type { AgentRunCtx } from './agent-run-ctx';
import { toAISdkTools } from '../tools/ai-sdk-adapter';
import { LARK_RUNNER_SYSTEM, LARK_TOOL_IDS } from './prompts/lark.prompt';
import {
  runWithCircuitBreaker,
  CircuitBreakerOpenError,
  GEMINI_CIRCUIT_OPTIONS,
} from '../../../shared/circuit-breaker';
import {
  appendToolTrace,
  emitSpecialistFinished,
  emitSpecialistStarted,
  emitSpecialistStepToolResults,
} from './tool-trace';

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

  const actorKey = 'lark_ops';
  const toolNames = Object.keys(tools);
  const startMs = Date.now();
  emitSpecialistStarted({
    tracer: ctx.tracer,
    actorKey,
    toolName: actorKey,
    task: args.task,
    toolCount: toolNames.length,
  });

  try {
    const { text, steps } = await runWithCircuitBreaker(
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
    emitSpecialistStepToolResults({ tracer: ctx.tracer, actorKey, steps });
    const result = appendToolTrace(text || 'Done.', steps);
    log.info('lark_runner.done', { replyLength: result.length });
    emitSpecialistFinished({ tracer: ctx.tracer, actorKey, toolName: actorKey, output: result, startMs });
    return result;
  } catch (e) {
    if (e instanceof CircuitBreakerOpenError) {
      log.warn('lark_runner.circuit_open', { retryAt: e.retryAt });
      const output = 'error: AI service temporarily unavailable, please try again shortly.';
      emitSpecialistFinished({ tracer: ctx.tracer, actorKey, toolName: actorKey, output, startMs });
      return output;
    }
    const msg = e instanceof Error ? e.message : String(e);
    log.error('lark_runner.error', { error: msg });
    const output = `error: ${msg}`;
    emitSpecialistFinished({ tracer: ctx.tracer, actorKey, toolName: actorKey, output, startMs });
    return output;
  }
}
