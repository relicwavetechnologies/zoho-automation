/**
 * LLM proxy route — desktop/PI → backend → the model's provider.
 *
 *   POST /api/llm/v1/chat/completions   (DeepSeek, member auth)
 *   POST /api/llm/v1/responses          (OpenAI/Luna, member auth)
 *
 * The backend gates the request (block / budget / rate / model), forwards it to
 * whichever provider serves the requested model with that provider's real key,
 * streams the SSE response straight back to PI, and on completion records the
 * provider's AUTHORITATIVE token usage against the run. PI holds no key — it
 * authenticates with its member token. Enabled only when LLM_PROXY_ENABLED=true;
 * otherwise this router isn't mounted.
 *
 * Each request shape is forwarded unchanged to the matching provider endpoint.
 * The only normalization is authoritative usage, which is stored in the
 * provider-neutral shape consumed by LlmProxyService.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { asChannelKey } from '../../domain/channel/runtime-channel';
import type { Logger } from '../../shared/logger';
import { LlmProxyService, type ProviderUsage } from '../../application/proxy/llm-proxy.service';
import { canonicalModel, providerOf, type ModelProvider } from '../../application/observability/pricing';
import type { ProxyKeyStore } from '../../application/proxy/proxy-key.store';
import type { ApiKeyExhaustionNotifierPort } from '../../application/governance/api-key-exhaustion.notifier';
import { isApiKeyExhausted } from '../../application/governance/api-key-exhaustion.classifier';
import {
  measureRunLatency,
  type RunLatencyRecorder,
} from '../../application/observability/run-latency-recorder';
import {
  ProviderStreamMilestones,
  type ProviderStreamMilestone,
} from '../../application/observability/provider-stream-milestones';

export interface LlmProxyRoutesDeps {
  logger:  Logger;
  store:   ProxyKeyStore;   // resolves the provider key server-side (never leaves the backend)
  service: LlmProxyService; // shared with Lark so policy/rate accounting has one authority
  /** Upstream origin per provider, e.g. { deepseek: 'https://api.deepseek.com' }. */
  baseUrls: Record<ModelProvider, string>;
  apiKeyExhaustion?: ApiKeyExhaustionNotifierPort;
  latencyRecorder?: RunLatencyRecorder;
}

/** How the provider is named to an admin in a 503. */
const PROVIDER_LABEL: Record<ModelProvider, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
};
interface ProxyBody {
  model?: string;
  messages?: unknown[];
  input?: unknown;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  divo_run_id?: string;
  divo_trace_mode?: 'desktop';
  /** Causal parent minted by the Divo Pi extension; never forwarded upstream. */
  divo_parent_span_id?: string;
  /** Internal, non-conversation request kinds. Never forwarded upstream. */
  divo_request_kind?: 'thread_title';
  /** Local desktop thread id for auxiliary token attribution. */
  divo_thread_id?: string;
  [k: string]: unknown;
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

const THREAD_TITLE_REQUEST_KIND = 'thread_title' as const;
const THREAD_TITLE_AGENT_TARGET = 'desktop.thread_title';

function isThreadTitleRequest(body: ProxyBody): boolean {
  return body.divo_request_kind === THREAD_TITLE_REQUEST_KIND;
}

function auxiliaryThreadId(body: ProxyBody): string | undefined {
  const threadId = typeof body.divo_thread_id === 'string'
    ? body.divo_thread_id.trim()
    : '';
  return threadId || undefined;
}

function normalizeUsage(value: unknown, responsesApi: boolean): ProviderUsage | null {
  if (!value || typeof value !== 'object') return null;
  if (!responsesApi) return value as ProviderUsage;
  const usage = value as ResponsesUsage;
  return {
    ...(usage.input_tokens !== undefined ? { prompt_tokens: usage.input_tokens } : {}),
    ...(usage.output_tokens !== undefined ? { completion_tokens: usage.output_tokens } : {}),
    ...(usage.input_tokens_details !== undefined
      ? { prompt_tokens_details: usage.input_tokens_details }
      : {}),
  };
}

/** Pull the terminal usage object + resolved model id out of an SSE buffer. */
function extractFinal(sse: string, responsesApi: boolean): { usage: ProviderUsage | null; model: string | null } {
  let usage: ProviderUsage | null = null;
  let model: string | null = null;
  for (const line of sse.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as {
        usage?: ProviderUsage;
        model?: string;
        response?: { usage?: ResponsesUsage; model?: string };
      };
      const terminal = responsesApi ? obj.response : obj;
      const normalized = normalizeUsage(terminal?.usage, responsesApi);
      if (normalized) usage = normalized;
      if (typeof terminal?.model === 'string') model = terminal.model;
    } catch { /* partial/non-JSON keepalive line */ }
  }
  return { usage, model };
}

export function createLlmProxyRoutes(deps: LlmProxyRoutesDeps): Router {
  const router = Router();
  const svc = deps.service;
  const log = deps.logger.child({ service: 'llm-proxy' });

  const handleRequest = async (req: Request, res: Response): Promise<void> => {
    const companyId = res.locals['companyId'] as string | undefined;
    const userId = res.locals['userId'] as string | undefined;
    if (!companyId || !userId) { res.status(401).json({ error: { message: 'Unauthenticated', type: 'auth' } }); return; }
    const channel = asChannelKey(res.locals['channel']);
    const runtimeThreadId = res.locals['runtimeThreadId'] as string | undefined;

    const startedAt = Date.now();
    const responsesApi = req.path === '/v1/responses';
    const body = (req.body ?? {}) as ProxyBody;
    const threadTitleRequest = isThreadTitleRequest(body);
    const threadId = auxiliaryThreadId(body);
    const attributedThreadId = runtimeThreadId ?? threadId;
    const auxiliaryAuditTarget = threadTitleRequest
      ? { agentTarget: THREAD_TITLE_AGENT_TARGET }
      : {};
    // Canonicalize to one of our priced models so the allow-list + pricing are exact.
    const model = canonicalModel(typeof body.model === 'string' ? body.model : undefined);
    const provider = providerOf(model);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const contentLength = Number(req.header('content-length'));
    const requestBytes = Number.isSafeInteger(contentLength) && contentLength >= 0
      ? contentLength
      : undefined;
    const toolCount = Array.isArray(body['tools']) ? body['tools'].length : 0;
    const providedRunId = threadTitleRequest
      ? undefined
      : (req.header('x-divo-run')
        || (typeof body.divo_run_id === 'string' ? body.divo_run_id : '')
        || req.header('session_id')
        || (res.locals['sessionId'] as string | undefined));
    const runId = providedRunId || randomUUID();
    const latencyTrace = providedRunId && deps.latencyRecorder
      ? deps.latencyRecorder.trace({
          runId,
          companyId,
          userId,
          source: 'llm-proxy',
          ...(typeof body.divo_parent_span_id === 'string'
            ? { parentSpanId: body.divo_parent_span_id }
            : {}),
        })
      : undefined;
    const proxySpan = latencyTrace?.startSpan({
      name: 'provider.proxy.request',
      category: 'provider',
      attributes: {
        provider,
        model,
        responsesApi,
        messageCount: messages.length,
        toolCount,
        ...(requestBytes !== undefined ? { requestBytes } : {}),
      },
    });
    const proxyParent = proxySpan ? { parentSpanId: proxySpan.spanId } : {};
    if (threadTitleRequest) {
      log.info('proxy.thread_title.accepted', {
        userId,
        threadId,
        model,
      });
    }

    let requestFailed = false;
    try {
    // ── Gate ────────────────────────────────────────────────────────────────
    const gate = await measureRunLatency(
      latencyTrace,
      { name: 'provider.policy.gate', category: 'authorization', ...proxyParent },
      () => svc.gate({ companyId, userId, model }),
    );
    if (!gate.allow) {
      log.info('proxy.denied', { userId, model, reason: gate.reason });
      const httpStatus = gate.status ?? 403;
      res.status(httpStatus).json({ error: { message: gate.reason ?? 'Denied', type: 'guardrails' } });
      void svc.recordAudit({ companyId, userId, model, provider, channel, decision: 'denied', reason: gate.reason ?? 'guardrails', httpStatus, latencyMs: Date.now() - startedAt, ...auxiliaryAuditTarget });
      return;
    }

    // ── Resolve the upstream key (company → platform) ─────────────────────────
    const resolved = await measureRunLatency(
      latencyTrace,
      { name: 'provider.key.resolve', category: 'persistence', ...proxyParent },
      () => deps.store.resolve(provider, companyId),
    );
    if (!resolved) {
      log.warn('proxy.no_key', { companyId, provider });
      res.status(503).json({ error: { message: `The AI proxy has no ${PROVIDER_LABEL[provider]} key configured. Add one in Guardrails.`, type: 'not_configured' } });
      void svc.recordAudit({ companyId, userId, model, provider, channel, decision: 'denied', reason: 'not_configured', httpStatus: 503, latencyMs: Date.now() - startedAt, ...auxiliaryAuditTarget });
      return;
    }

    // ── Correlate to a run ────────────────────────────────────────────────────
    const desktopOwnsTimeline = body.divo_trace_mode === 'desktop'
      && typeof body.divo_run_id === 'string'
      && body.divo_run_id.length > 0;
    let executionId: string | null = null;
    if (!threadTitleRequest) {
      try {
        executionId = await measureRunLatency(
          latencyTrace,
          { name: 'provider.run.resolve', category: 'persistence', ...proxyParent },
          () => svc.ensureRun({ runId, companyId, userId, channel }),
        );
        latencyTrace?.bindExecutionId(executionId);
        if (!desktopOwnsTimeline) {
          await measureRunLatency(
            latencyTrace,
            {
              name: 'provider.tool-results.persist',
              category: 'persistence',
              ...proxyParent,
            },
            () => svc.recordToolResults(executionId!, messages as never[]),
          );
        }
      } catch (e) {
        log.warn('proxy.trace.pre_failed', { error: String(e) }); // never block the call on trace failure
      }
    }

    // ── Forward to the provider ───────────────────────────────────────────────
    // Forward the canonical name, not the client's. The allow-list, the budget
    // check, and the pricing all ran against `model`; forwarding `body.model`
    // would authorise one model and then call another. It is also the only
    // correct name to send — DeepSeek has retired the legacy aliases that
    // `canonicalModel` still accepts from clients, and now rejects them.
    const forwardBody: ProxyBody = { ...body, model };
    delete forwardBody.divo_run_id;
    delete forwardBody.divo_trace_mode;
    delete forwardBody.divo_parent_span_id;
    delete forwardBody.divo_request_kind;
    delete forwardBody.divo_thread_id;
    const wantsStream = forwardBody.stream !== false;
    if (!responsesApi && wantsStream && !forwardBody.stream_options?.include_usage) {
      forwardBody.stream_options = { ...(forwardBody.stream_options ?? {}), include_usage: true };
    }

    const controller = new AbortController();
    // `IncomingMessage.close` may fire after a fully received request. It is
    // not equivalent to a client abort, and using it here races non-streaming
    // auxiliary requests. Abort only when the request was actually aborted or
    // the response closes before it has been written.
    req.on('aborted', () => controller.abort());
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    let upstream: globalThis.Response;
    const upstreamStartedAtMs = Date.now();
    try {
      const endpoint = responsesApi ? '/v1/responses' : '/v1/chat/completions';
      upstream = await measureRunLatency(
        latencyTrace,
        {
          name: 'provider.upstream.headers',
          category: 'provider',
          ...proxyParent,
          attributes: { provider, model },
        },
        () => fetch(`${deps.baseUrls[provider]}${endpoint}`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolved.key}` },
          body:    JSON.stringify(forwardBody),
          signal:  controller.signal,
        }),
      );
    } catch (e) {
      log.error('proxy.upstream.unreachable', { provider, error: String(e) });
      res.status(502).json({ error: { message: 'Upstream unreachable', type: 'upstream' } });
      void svc.recordAudit({ companyId, userId, executionId, model, provider, channel, decision: 'denied', reason: 'upstream', httpStatus: 502, latencyMs: Date.now() - startedAt, keySource: resolved.source, ...auxiliaryAuditTarget });
      return;
    }
    if (upstream.ok) {
      void deps.store.touch(provider, resolved.source, companyId);
      void deps.apiKeyExhaustion?.clear(companyId, provider);
    } else {
      void maybeNotifyUpstreamExhaustion(deps, companyId, provider, upstream.status, () => upstream.clone().text());
    }

    const audit = (ok: boolean, usage: ProviderUsage | null, responseModel?: string | null, reason?: string) =>
      void svc.recordAudit({
        companyId, userId, executionId,
        channel,
        provider,
        model: canonicalModel(responseModel ?? model),
        decision: ok ? 'allowed' : 'denied',
        reason: ok ? undefined : (reason ?? `upstream_${upstream.status}`),
        httpStatus: upstream.status,
        usage: ok ? usage : null,
        latencyMs: Date.now() - startedAt,
        keySource: resolved.source,
        ...auxiliaryAuditTarget,
      });

    const recordUsage = async (usage: ProviderUsage | null, responseModel?: string | null) => measureRunLatency(
      latencyTrace,
      { name: 'provider.usage.persist', category: 'persistence', ...proxyParent },
      async () => {
      if (!usage) return;
      // Prefer the model the provider actually served (aliases resolved), else the request's.
      const served = canonicalModel(responseModel ?? model);
      if (threadTitleRequest) {
        await svc.recordAuxiliaryUsage({
          companyId,
          userId,
          model: served,
          provider: providerOf(served),
          usage,
          agentTarget: THREAD_TITLE_AGENT_TARGET,
          channel,
          ...(attributedThreadId ? { threadId: attributedThreadId } : {}),
        });
        return;
      }
      if (!executionId) return;
      try {
        await svc.recordModelCall({
          executionId,
          companyId,
          userId,
          model: served,
          provider: providerOf(served),
          usage,
          channel,
          ...(runtimeThreadId ? { threadId: runtimeThreadId } : {}),
          recordEvent: !desktopOwnsTimeline,
        });
      } catch (e) {
        log.warn('proxy.usage.record_failed', { error: String(e) });
      }
      },
    );

    // Non-streaming: forward JSON + read usage directly.
    if (!wantsStream || !upstream.body) {
      const text = await measureRunLatency(
        latencyTrace,
        { name: 'provider.response.read', category: 'provider', ...proxyParent },
        () => upstream.text(),
      );
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
      res.send(text);
      let parsed: { usage?: unknown; model?: string } = {};
      let usage: ProviderUsage | null = null;
      if (upstream.ok) {
        try {
          parsed = JSON.parse(text) as { usage?: unknown; model?: string };
          usage = normalizeUsage(parsed.usage, responsesApi);
          await recordUsage(usage, parsed.model ?? null);
        } catch { /* ignore */ }
      }
      if (threadTitleRequest) {
        log.info('proxy.thread_title.completed', {
          userId,
          threadId,
          model: canonicalModel(parsed.model ?? model),
          status: upstream.status,
          latencyMs: Date.now() - startedAt,
        });
      }
      audit(upstream.ok, usage, parsed.model ?? null);
      return;
    }

    // Streaming: pipe SSE straight through while capturing the usage chunk.
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const milestoneParentId = proxySpan?.spanId ?? `llm-proxy:${randomUUID()}`;
    const milestones = latencyTrace
      ? new ProviderStreamMilestones(event => {
          const names: Record<ProviderStreamMilestone, string> = {
            first_byte: 'provider.upstream.first_byte',
            first_reasoning: 'provider.upstream.first_reasoning',
            first_text: 'provider.upstream.first_text',
          };
          latencyTrace.addCompleted({
            spanId: `${milestoneParentId}.${event.kind}`,
            parentSpanId: milestoneParentId,
            name: names[event.kind],
            category: 'provider',
            source: 'llm-proxy',
            startedAtMs: upstreamStartedAtMs,
            endedAtMs: event.atMs,
            durationMs: Math.max(0, event.atMs - upstreamStartedAtMs),
            status: 'ok',
            attributes: { provider, model },
          });
        })
      : undefined;
    let acc = '';
    let interrupted = false;
    await measureRunLatency(
      latencyTrace,
      { name: 'provider.response.stream', category: 'provider', ...proxyParent },
      async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              milestones?.observe(value);
              res.write(Buffer.from(value));
              acc += decoder.decode(value, { stream: true });
            }
          }
        } catch (e) {
          interrupted = true; // client disconnect or upstream stream abort after 200
          log.warn('proxy.stream.interrupted', { error: String(e) });
        } finally {
          milestones?.finish();
          res.end();
        }
      },
    );
    // A stream that broke mid-flight isn't a clean success — don't count it as an
    // allowed 200 in the audit/metrics, and don't trust a partial usage chunk.
    const ok = upstream.ok && !interrupted;
    const final = ok ? extractFinal(acc, responsesApi) : { usage: null, model: null };
    if (ok) await recordUsage(final.usage, final.model);
    if (threadTitleRequest) {
      log.info('proxy.thread_title.completed', {
        userId,
        threadId,
        model: canonicalModel(final.model ?? model),
        status: upstream.status,
        latencyMs: Date.now() - startedAt,
        interrupted,
      });
    }
    audit(ok, final.usage, final.model, interrupted ? 'stream_interrupted' : undefined);
    } catch (error) {
      requestFailed = true;
      throw error;
    } finally {
      const statusCode = typeof res.statusCode === 'number' ? res.statusCode : null;
      proxySpan?.end(
        requestFailed || (statusCode !== null && statusCode >= 400) ? 'error' : 'ok',
        { httpStatus: statusCode },
      );
      void latencyTrace?.flush();
    }
  };

  router.post('/v1/chat/completions', handleRequest);
  router.post('/v1/responses', handleRequest);

  return router;
}

async function maybeNotifyUpstreamExhaustion(
  deps: LlmProxyRoutesDeps,
  companyId: string,
  provider: ModelProvider,
  httpStatus: number,
  readBody: () => Promise<string>,
): Promise<void> {
  if (!deps.apiKeyExhaustion) return;
  let message = '';
  try {
    message = await readBody();
  } catch {
    message = '';
  }
  let code: string | undefined;
  try {
    const parsed = JSON.parse(message) as { error?: { code?: string; type?: string; message?: string } };
    code = parsed.error?.code ?? parsed.error?.type;
    if (!message && parsed.error?.message) message = parsed.error.message;
  } catch {
    /* non-JSON body */
  }
  if (!isApiKeyExhausted({ httpStatus, code, message })) return;
  await deps.apiKeyExhaustion.notifyIfExhausted({
    companyId,
    provider,
    httpStatus,
    code,
    message: message.slice(0, 500) || `${PROVIDER_LABEL[provider]} upstream HTTP ${httpStatus}`,
    source: 'llm-proxy.chat.completions',
  });
}
