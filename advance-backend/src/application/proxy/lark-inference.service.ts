import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';
import type { Logger } from '../../shared/logger';
import type { RunContext } from '../../domain/orchestration/run-context';
import type { ProxyKeyStore, ResolvedKey } from './proxy-key.store';
import { LlmProxyService, type DeepSeekUsage } from './llm-proxy.service';
import type { OrchestrationTracer } from '../observability/orchestration-tracer';

type DeepSeekModel = ReturnType<ReturnType<typeof createDeepSeek>>;

export const LARK_MODEL_ID = 'deepseek-v4-pro';
const DEEPSEEK_UPSTREAM_MODEL_ID = 'deepseek-reasoner';

export interface LarkInferenceContext {
  runContext: RunContext;
  executionRunId?: string;
  threadId?: string;
  agentTarget?: string;
  tracer?: OrchestrationTracer;
}

export interface LarkInferenceServiceDeps {
  store: ProxyKeyStore;
  policy: LlmProxyService;
  logger: Logger;
  baseUrl: string;
  createUpstreamModel?: (apiKey: string) => DeepSeekModel;
}

class LarkInferenceUnavailableError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'LarkInferenceUnavailableError';
  }
}

function toDeepSeekUsage(usage: {
  inputTokens: { total: number | undefined; noCache: number | undefined; cacheRead: number | undefined };
  outputTokens: { total: number | undefined };
}): DeepSeekUsage {
  const cacheHit = usage.inputTokens.cacheRead ?? 0;
  return {
    prompt_tokens: usage.inputTokens.total ?? (usage.inputTokens.noCache ?? 0) + cacheHit,
    prompt_cache_hit_tokens: cacheHit,
    prompt_cache_miss_tokens: usage.inputTokens.noCache ?? 0,
    completion_tokens: usage.outputTokens.total ?? 0,
  };
}

/**
 * Creates a per-run DeepSeek model for Lark. The model is deliberately pinned:
 * agent/company model overrides cannot move Lark away from Pro. Credentials,
 * block/model/rate/budget policy, audit rows and token usage remain backend-owned.
 */
export class LarkInferenceService {
  private readonly log: Logger;

  constructor(private readonly deps: LarkInferenceServiceDeps) {
    this.log = deps.logger.child({ service: 'lark-inference' });
  }

  createModel(context: LarkInferenceContext): LanguageModel {
    const prepare = async (startedAt: number): Promise<{ model: DeepSeekModel; key: ResolvedKey }> => {
      const gate = await this.deps.policy.gate({
        companyId: context.runContext.companyId,
        userId: context.runContext.userId,
        model: LARK_MODEL_ID,
      });
      if (!gate.allow) {
        const status = gate.status ?? 403;
        void this.audit(context, startedAt, 'denied', status, null, null, gate.reason ?? 'guardrails');
        throw new LarkInferenceUnavailableError(status, gate.reason ?? 'Lark AI access is denied by policy.');
      }

      const key = await this.deps.store.resolve(context.runContext.companyId);
      if (!key) {
        void this.audit(context, startedAt, 'denied', 503, null, null, 'not_configured');
        throw new LarkInferenceUnavailableError(503, 'DeepSeek is not configured for this company. Add a key in Guardrails.');
      }

      const model = this.deps.createUpstreamModel
        ? this.deps.createUpstreamModel(key.key)
        : createDeepSeek({ apiKey: key.key, baseURL: this.deps.baseUrl })(DEEPSEEK_UPSTREAM_MODEL_ID);
      return { model, key };
    };

    const service = this;
    const wrapped: DeepSeekModel = {
      specificationVersion: 'v3',
      provider: 'deepseek',
      modelId: LARK_MODEL_ID,
      supportedUrls: {},
      async doGenerate(options) {
        const startedAt = Date.now();
        let resolved: ResolvedKey | null = null;
        try {
          const prepared = await prepare(startedAt);
          resolved = prepared.key;
          const result = await prepared.model.doGenerate(options);
          const usage = toDeepSeekUsage(result.usage);
          await service.recordSuccess(context, startedAt, usage, resolved);
          return result;
        } catch (error) {
          if (!(error instanceof LarkInferenceUnavailableError)) {
            void service.audit(context, startedAt, 'denied', 502, null, resolved, 'upstream');
          }
          throw error;
        }
      },
      async doStream(options) {
        const startedAt = Date.now();
        let resolved: ResolvedKey | null = null;
        try {
          const prepared = await prepare(startedAt);
          resolved = prepared.key;
          const result = await prepared.model.doStream(options);
          const reader = result.stream.getReader();
          let terminalRecorded = false;
          const stream = new ReadableStream({
            async pull(controller) {
              try {
                const next = await reader.read();
                if (next.done) {
                  if (!terminalRecorded) {
                    terminalRecorded = true;
                    void service.audit(context, startedAt, 'denied', 502, null, resolved, 'stream_missing_finish');
                  }
                  controller.close();
                  return;
                }
                if (next.value.type === 'finish') {
                  terminalRecorded = true;
                  const usage = toDeepSeekUsage(next.value.usage);
                  void service.recordSuccess(context, startedAt, usage, resolved!);
                } else if (next.value.type === 'error') {
                  terminalRecorded = true;
                  void service.audit(context, startedAt, 'denied', 502, null, resolved, 'stream_error');
                }
                controller.enqueue(next.value);
              } catch (error) {
                if (!terminalRecorded) {
                  terminalRecorded = true;
                  void service.audit(context, startedAt, 'denied', 502, null, resolved, 'stream_interrupted');
                }
                controller.error(error);
              }
            },
            cancel(reason) {
              if (!terminalRecorded) {
                terminalRecorded = true;
                void service.audit(context, startedAt, 'denied', 499, null, resolved, 'client_cancelled');
              }
              return reader.cancel(reason);
            },
          });
          return { ...result, stream };
        } catch (error) {
          if (!(error instanceof LarkInferenceUnavailableError)) {
            void service.audit(context, startedAt, 'denied', 502, null, resolved, 'upstream');
          }
          throw error;
        }
      },
    };
    return wrapped;
  }

  private async recordSuccess(
    context: LarkInferenceContext,
    startedAt: number,
    usage: DeepSeekUsage,
    key: ResolvedKey,
  ): Promise<void> {
    await this.deps.store.touch(key.source, context.runContext.companyId);
    if (context.executionRunId) {
      try {
        const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
        const cacheMiss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens ?? 0) - cacheHit);
        const output = usage.completion_tokens ?? 0;
        context.tracer?.emit({
          phase: 'model', eventType: 'model_call', actorType: 'model',
          actorKey: LARK_MODEL_ID, title: LARK_MODEL_ID, status: 'success',
          payload: {
            provider: 'deepseek', model: LARK_MODEL_ID,
            channel: 'lark', agentTarget: context.agentTarget ?? 'lark.orchestration',
            usage: { input: cacheMiss, output, cacheRead: cacheHit },
          },
        });
        await this.deps.policy.recordModelCall({
          executionId: context.executionRunId,
          companyId: context.runContext.companyId,
          userId: context.runContext.userId,
          model: LARK_MODEL_ID,
          provider: 'deepseek',
          usage,
          agentTarget: context.agentTarget ?? 'lark.orchestration',
          channel: 'lark',
          recordEvent: false,
          ...(context.threadId ? { threadId: context.threadId } : {}),
        });
      } catch (error) {
        this.log.warn('usage.record_failed', { error: String(error) });
      }
    }
    await this.audit(context, startedAt, 'allowed', 200, usage, key);
  }

  private audit(
    context: LarkInferenceContext,
    startedAt: number,
    decision: 'allowed' | 'denied',
    httpStatus: number,
    usage: DeepSeekUsage | null,
    key: ResolvedKey | null,
    reason?: string,
  ): Promise<void> {
    return this.deps.policy.recordAudit({
      companyId: context.runContext.companyId,
      userId: context.runContext.userId,
      ...(context.executionRunId ? { executionId: context.executionRunId } : {}),
      model: LARK_MODEL_ID,
      decision,
      httpStatus,
      ...(reason ? { reason } : {}),
      usage,
      latencyMs: Date.now() - startedAt,
      keySource: key?.source ?? null,
      channel: 'lark',
      provider: 'deepseek',
      agentTarget: context.agentTarget ?? 'lark.orchestration',
    });
  }
}
