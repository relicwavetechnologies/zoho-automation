import { generateText, stepCountIs } from 'ai';
import type { AgentRunCtx } from './agent-run-ctx';
import { toAISdkTools } from '../tools/ai-sdk-adapter';
import { CONTEXT_RUNNER_SYSTEM, CONTEXT_TOOL_IDS } from './prompts/context.prompt';
import {
  runWithCircuitBreaker,
  CircuitBreakerOpenError,
  GEMINI_CIRCUIT_OPTIONS,
} from '../../../shared/circuit-breaker';
import { gradeAnswer } from '../../retrieval/answer-grader';

export async function runContextAgent(
  args: { task: string },
  ctx: AgentRunCtx,
): Promise<string> {
  const log = ctx.logger.child({ runner: 'context' });
  log.info('context_runner.start', { task: args.task.slice(0, 120) });

  const tools = toAISdkTools(ctx.allTools, {
    runContext: ctx.runContext,
    perm:       ctx.perm,
    logger:     ctx.logger,
    clock:      ctx.clock,
    ...(ctx.approvalGate ? { approvalGate: ctx.approvalGate } : {}),
    ...(ctx.chatId !== undefined ? { chatId: ctx.chatId } : {}),
  }, CONTEXT_TOOL_IDS);

  try {
    const result = await runWithCircuitBreaker(
      'gemini', 'context-runner', GEMINI_CIRCUIT_OPTIONS,
      () => generateText({
        model:       ctx.model,
        system:      CONTEXT_RUNNER_SYSTEM,
        prompt:      args.task,
        tools,
        stopWhen:    [stepCountIs(10)],
        temperature: 0,
        abortSignal: AbortSignal.timeout(60_000),
      }),
      log,
    );

    const text = result.text || 'No results found.';

    // ── Faithfulness grading after documentRag ─────────────────────────────
    // Extract retrieved chunks from any documentRag tool calls across all steps.
    // If the generated answer is not grounded in those chunks, refine once.
    if (ctx.geminiApiKey) {
      const ragChunks = extractRagChunks(result.steps as unknown[]);
      if (ragChunks.length > 0) {
        const grade = await gradeAnswer({
          answer:        text,
          contextChunks: ragChunks,
          query:         args.task,
          geminiApiKey:  ctx.geminiApiKey,
        }, log);

        if (!grade.grounded) {
          log.warn('context_runner.faithfulness_fail', { reason: grade.reason });
          // One bounded refine: re-run with explicit grounding instruction
          const refinedResult = await runWithCircuitBreaker(
            'gemini', 'context-runner-refine', GEMINI_CIRCUIT_OPTIONS,
            () => generateText({
              model:  ctx.model,
              system: CONTEXT_RUNNER_SYSTEM,
              prompt: `${args.task}\n\nIMPORTANT: Base your answer ONLY on the document context you retrieved. If the context does not contain the answer, say so explicitly — do not infer or hallucinate.`,
              tools,
              stopWhen:    [stepCountIs(10)],
              temperature: 0,
              abortSignal: AbortSignal.timeout(45_000),
            }),
            log,
          ).catch(() => null);

          if (refinedResult?.text) {
            log.info('context_runner.refined', { originalLength: text.length, refinedLength: refinedResult.text.length });
            return refinedResult.text;
          }
        }
      }
    }

    log.info('context_runner.done', { replyLength: text.length });
    return text;
  } catch (e) {
    if (e instanceof CircuitBreakerOpenError) {
      log.warn('context_runner.circuit_open', { retryAt: e.retryAt });
      return 'error: AI service temporarily unavailable, please try again shortly.';
    }
    const msg = e instanceof Error ? e.message : String(e);
    log.error('context_runner.error', { error: msg });
    return `error: ${msg}`;
  }
}

/** Extract text chunks from documentRag tool results across all generation steps.
 *  Supports both DynamicToolResult (.output) and StaticToolResult (.result). */
function extractRagChunks(steps: readonly unknown[]): string[] {
  const chunks: string[] = [];
  for (const step of steps) {
    const stepObj = step as Record<string, unknown>;
    const toolResults = (stepObj['toolResults'] ?? stepObj['dynamicToolResults']) as unknown[] | undefined;
    for (const tr of toolResults ?? []) {
      const tool = tr as Record<string, unknown>;
      if (tool['toolName'] !== 'documentRag') continue;
      // DynamicToolResult uses .output; StaticToolResult uses .result
      const raw = tool['output'] ?? tool['result'];
      try {
        const parsed = typeof raw === 'string'
          ? JSON.parse(raw) as unknown
          : raw;
        const results = (parsed as Record<string, unknown>)?.['results'];
        if (Array.isArray(results)) {
          for (const r of results) {
            const text = (r as Record<string, unknown>)?.['text'];
            if (typeof text === 'string' && text.trim()) chunks.push(text);
          }
        }
      } catch { /* ignore malformed */ }
    }
  }
  return chunks;
}
