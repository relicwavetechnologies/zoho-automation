import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';
import type { Logger } from '../../shared/logger';
import type { RunContext } from '../../domain/orchestration/run-context';
import type { ProxyKeyStore, ResolvedKey } from './proxy-key.store';
import { LlmProxyService, type DeepSeekUsage } from './llm-proxy.service';
import type { OrchestrationTracer } from '../observability/orchestration-tracer';
import { asUserFacing } from '../../shared/user-facing-error';

type DeepSeekModel = ReturnType<ReturnType<typeof createDeepSeek>>;

/**
 * The name we bill, trace, and call DeepSeek by.
 *
 * These used to differ: `deepseek-reasoner` was the API's own name for this
 * model, translated here so billing and traces could use the v4 name everywhere
 * else. DeepSeek retired that alias and now rejects it outright, so there is no
 * translation left to do — one name, used in one place.
 *
 * Kept as the *preferred* model rather than the pinned one — see
 * `LARK_MODEL_PREFERENCE`.
 */
export const LARK_MODEL_ID = 'deepseek-v4-pro';

export const LARK_MODEL_IDS = {
  pro: 'deepseek-v4-pro',
  flash: 'deepseek-v4-flash',
} as const;

export type LarkModelId = typeof LARK_MODEL_IDS[keyof typeof LARK_MODEL_IDS];

/**
 * Which model Lark runs on, best first.
 *
 * Pro was previously pinned, which meant Lark asked for a model most members
 * are not granted: the proxy policy defaults to Flash-only and Pro must be
 * granted deliberately. Every such member got a 403 before inference started.
 * Asking for the best model the account actually holds is both what an admin
 * expects from a per-model permission and the difference between Divo working
 * and not.
 */
export const LARK_MODEL_PREFERENCE = [LARK_MODEL_IDS.pro, LARK_MODEL_IDS.flash] as const;

export interface LarkInferenceContext {
  runContext: RunContext;
  executionRunId?: string;
  threadId?: string;
  agentTarget?: string;
  tracer?: OrchestrationTracer;
  /** Explicit internal per-run selection; policy still authorizes the model. */
  requestedModelId?: LarkModelId;
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
    // Policy refusals are the answer, not a symptom. Marked user-facing so the
    // engine shows "Pro is not enabled for this account" instead of burying it
    // under a generic apology the user can only respond to by retrying.
    asUserFacing(this, message);
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
 * Creates a per-run DeepSeek model for Lark. Normal runs choose the best model
 * the member holds; an internal caller may request Flash or Pro explicitly.
 * The same backend model gate still authorizes that exact choice. Credentials,
 * rate/budget policy, audit rows, and token usage remain backend-owned.
 */
export class LarkInferenceService {
  private readonly log: Logger;

  constructor(private readonly deps: LarkInferenceServiceDeps) {
    this.log = deps.logger.child({ service: 'lark-inference' });
  }

  /**
   * Resolve the best model this member holds.
   *
   * Falls back to the least-privileged preference when the account holds none
   * of them, so the refusal comes from `gate` — one place that audits the
   * denial and phrases it — rather than from two.
   */
  private async resolveModelId(userId: string, requestedModelId?: LarkModelId): Promise<string> {
    if (requestedModelId) return requestedModelId;
    try {
      const allowed = await this.deps.policy.allowedModelsFor(String(userId));
      return LARK_MODEL_PREFERENCE.find(model => allowed.includes(model))
        ?? LARK_MODEL_PREFERENCE[LARK_MODEL_PREFERENCE.length - 1]!;
    } catch (error) {
      this.log.warn('model.resolve_failed', { error: String(error) });
      return LARK_MODEL_PREFERENCE[LARK_MODEL_PREFERENCE.length - 1]!;
    }
  }

  async createModel(context: LarkInferenceContext): Promise<LanguageModel> {
    const modelId = await this.resolveModelId(
      String(context.runContext.userId),
      context.requestedModelId,
    );
    this.log.info('model.selected', {
      modelId,
      companyId: String(context.runContext.companyId),
      userId: String(context.runContext.userId),
    });

    const prepare = async (startedAt: number): Promise<{ model: DeepSeekModel; key: ResolvedKey }> => {
      const gate = await this.deps.policy.gate({
        companyId: context.runContext.companyId,
        userId: context.runContext.userId,
        model: modelId,
      });
      if (!gate.allow) {
        const status = gate.status ?? 403;
        void this.audit(context, startedAt, 'denied', status, null, null, modelId, gate.reason ?? 'guardrails');
        throw new LarkInferenceUnavailableError(status, gate.reason ?? 'Lark AI access is denied by policy.');
      }

      const key = await this.deps.store.resolve(context.runContext.companyId);
      if (!key) {
        void this.audit(context, startedAt, 'denied', 503, null, null, modelId, 'not_configured');
        throw new LarkInferenceUnavailableError(503, 'DeepSeek is not configured for this company. Add a key in Guardrails.');
      }

      const model = this.deps.createUpstreamModel
        ? this.deps.createUpstreamModel(key.key)
        : createDeepSeek({ apiKey: key.key, baseURL: this.deps.baseUrl })(modelId);
      return { model, key };
    };

    const service = this;
    const wrapped: DeepSeekModel = {
      specificationVersion: 'v3',
      provider: 'deepseek',
      modelId,
      supportedUrls: {},
      async doGenerate(options) {
        const startedAt = Date.now();
        let resolved: ResolvedKey | null = null;
        try {
          const prepared = await prepare(startedAt);
          resolved = prepared.key;
          const result = await prepared.model.doGenerate(options);
          const usage = toDeepSeekUsage(result.usage);
          await service.recordSuccess(context, startedAt, usage, resolved, modelId);
          return result;
        } catch (error) {
          if (!(error instanceof LarkInferenceUnavailableError)) {
            void service.audit(context, startedAt, 'denied', 502, null, resolved, modelId, 'upstream');
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
                    void service.audit(context, startedAt, 'denied', 502, null, resolved, modelId, 'stream_missing_finish');
                  }
                  controller.close();
                  return;
                }
                if (next.value.type === 'finish') {
                  terminalRecorded = true;
                  const usage = toDeepSeekUsage(next.value.usage);
                  void service.recordSuccess(context, startedAt, usage, resolved!, modelId);
                } else if (next.value.type === 'error') {
                  terminalRecorded = true;
                  void service.audit(context, startedAt, 'denied', 502, null, resolved, modelId, 'stream_error');
                }
                controller.enqueue(next.value);
              } catch (error) {
                if (!terminalRecorded) {
                  terminalRecorded = true;
                  void service.audit(context, startedAt, 'denied', 502, null, resolved, modelId, 'stream_interrupted');
                }
                controller.error(error);
              }
            },
            cancel(reason) {
              if (!terminalRecorded) {
                terminalRecorded = true;
                void service.audit(context, startedAt, 'denied', 499, null, resolved, modelId, 'client_cancelled');
              }
              return reader.cancel(reason);
            },
          });
          return { ...result, stream };
        } catch (error) {
          if (!(error instanceof LarkInferenceUnavailableError)) {
            void service.audit(context, startedAt, 'denied', 502, null, resolved, modelId, 'upstream');
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
    modelId: string,
  ): Promise<void> {
    await this.deps.store.touch(key.source, context.runContext.companyId);
    if (context.executionRunId) {
      try {
        const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
        const cacheMiss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens ?? 0) - cacheHit);
        const output = usage.completion_tokens ?? 0;
        context.tracer?.emit({
          phase: 'model', eventType: 'model_call', actorType: 'model',
          actorKey: modelId, title: modelId, status: 'success',
          payload: {
            provider: 'deepseek', model: modelId,
            channel: 'lark', agentTarget: context.agentTarget ?? 'lark.orchestration',
            usage: { input: cacheMiss, output, cacheRead: cacheHit },
          },
        });
        await this.deps.policy.recordModelCall({
          executionId: context.executionRunId,
          companyId: context.runContext.companyId,
          userId: context.runContext.userId,
          model: modelId,
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
    await this.audit(context, startedAt, 'allowed', 200, usage, key, modelId);
  }

  private audit(
    context: LarkInferenceContext,
    startedAt: number,
    decision: 'allowed' | 'denied',
    httpStatus: number,
    usage: DeepSeekUsage | null,
    key: ResolvedKey | null,
    modelId: string,
    reason?: string,
  ): Promise<void> {
    return this.deps.policy.recordAudit({
      companyId: context.runContext.companyId,
      userId: context.runContext.userId,
      ...(context.executionRunId ? { executionId: context.executionRunId } : {}),
      model: modelId,
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
