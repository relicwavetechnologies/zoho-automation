/**
 * LLM proxy route — desktop/PI → backend → DeepSeek (OpenAI-compatible).
 *
 *   POST /api/llm/v1/chat/completions   (member auth)
 *
 * The backend gates the request (block / budget / rate / model), forwards it to
 * DeepSeek with the real key, streams the SSE response straight back to PI, and
 * on completion records DeepSeek's AUTHORITATIVE token usage against the run.
 * PI holds no key — it authenticates with its member token. Enabled only when
 * LLM_PROXY_ENABLED=true; otherwise this router isn't mounted.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type { Logger } from '../../shared/logger';
import { LlmProxyService, type DeepSeekUsage } from '../../application/proxy/llm-proxy.service';
import { canonicalModel } from '../../application/observability/pricing';
import type { ProxyKeyStore } from '../../application/proxy/proxy-key.store';

export interface LlmProxyRoutesDeps {
  logger:  Logger;
  store:   ProxyKeyStore;   // resolves the DeepSeek key server-side (never leaves the backend)
  service: LlmProxyService; // shared with Lark so policy/rate accounting has one authority
  baseUrl: string;          // e.g. https://api.deepseek.com
}

interface ChatBody {
  model?: string;
  messages?: unknown[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  divo_run_id?: string;
  divo_trace_mode?: 'desktop';
  [k: string]: unknown;
}

/** Pull the last usage object + the resolved model id out of an SSE buffer. */
function extractFinal(sse: string): { usage: DeepSeekUsage | null; model: string | null } {
  let usage: DeepSeekUsage | null = null;
  let model: string | null = null;
  for (const line of sse.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as { usage?: DeepSeekUsage; model?: string };
      if (obj.usage) usage = obj.usage;
      if (typeof obj.model === 'string') model = obj.model;  // DeepSeek resolves aliases here
    } catch { /* partial/non-JSON keepalive line */ }
  }
  return { usage, model };
}

export function createLlmProxyRoutes(deps: LlmProxyRoutesDeps): Router {
  const router = Router();
  const svc = deps.service;
  const log = deps.logger.child({ service: 'llm-proxy' });

  router.post('/v1/chat/completions', async (req: Request, res: Response): Promise<void> => {
    const companyId = res.locals['companyId'] as string | undefined;
    const userId = res.locals['userId'] as string | undefined;
    if (!companyId || !userId) { res.status(401).json({ error: { message: 'Unauthenticated', type: 'auth' } }); return; }

    const startedAt = Date.now();
    const body = (req.body ?? {}) as ChatBody;
    // Canonicalize to one of our two priced models so the allow-list + pricing are exact.
    const model = canonicalModel(typeof body.model === 'string' ? body.model : undefined);
    const messages = Array.isArray(body.messages) ? body.messages : [];

    // ── Gate ────────────────────────────────────────────────────────────────
    const gate = await svc.gate({ companyId, userId, model });
    if (!gate.allow) {
      log.info('proxy.denied', { userId, model, reason: gate.reason });
      const httpStatus = gate.status ?? 403;
      res.status(httpStatus).json({ error: { message: gate.reason ?? 'Denied', type: 'guardrails' } });
      void svc.recordAudit({ companyId, userId, model, decision: 'denied', reason: gate.reason ?? 'guardrails', httpStatus, latencyMs: Date.now() - startedAt });
      return;
    }

    // ── Resolve the upstream key (company → platform → env) ───────────────────
    const resolved = await deps.store.resolve(companyId);
    if (!resolved) {
      log.warn('proxy.no_key', { companyId });
      res.status(503).json({ error: { message: 'The AI proxy has no DeepSeek key configured. Add one in Guardrails.', type: 'not_configured' } });
      void svc.recordAudit({ companyId, userId, model, decision: 'denied', reason: 'not_configured', httpStatus: 503, latencyMs: Date.now() - startedAt });
      return;
    }

    // ── Correlate to a run ────────────────────────────────────────────────────
    const desktopOwnsTimeline = body.divo_trace_mode === 'desktop'
      && typeof body.divo_run_id === 'string'
      && body.divo_run_id.length > 0;
    const runId =
      (req.header('x-divo-run') || (typeof body.divo_run_id === 'string' ? body.divo_run_id : '') ||
        req.header('session_id') || (res.locals['sessionId'] as string | undefined) || randomUUID());
    let executionId: string | null = null;
    try {
      executionId = await svc.ensureRun({ runId, companyId, userId });
      if (!desktopOwnsTimeline) {
        await svc.recordToolResults(executionId, messages as never[]);
      }
    } catch (e) {
      log.warn('proxy.trace.pre_failed', { error: String(e) }); // never block the call on trace failure
    }

    // ── Forward to DeepSeek ───────────────────────────────────────────────────
    const forwardBody: ChatBody = { ...body };
    delete forwardBody.divo_run_id;
    delete forwardBody.divo_trace_mode;
    const wantsStream = forwardBody.stream !== false;
    if (wantsStream && !forwardBody.stream_options?.include_usage) {
      forwardBody.stream_options = { ...(forwardBody.stream_options ?? {}), include_usage: true };
    }

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${deps.baseUrl}/v1/chat/completions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolved.key}` },
        body:    JSON.stringify(forwardBody),
        signal:  controller.signal,
      });
    } catch (e) {
      log.error('proxy.upstream.unreachable', { error: String(e) });
      res.status(502).json({ error: { message: 'Upstream unreachable', type: 'upstream' } });
      void svc.recordAudit({ companyId, userId, executionId, model, decision: 'denied', reason: 'upstream', httpStatus: 502, latencyMs: Date.now() - startedAt, keySource: resolved.source });
      return;
    }
    if (upstream.ok) void deps.store.touch(resolved.source, companyId);

    const audit = (ok: boolean, usage: DeepSeekUsage | null, responseModel?: string | null, reason?: string) =>
      void svc.recordAudit({
        companyId, userId, executionId,
        model: canonicalModel(responseModel ?? model),
        decision: ok ? 'allowed' : 'denied',
        reason: ok ? undefined : (reason ?? `upstream_${upstream.status}`),
        httpStatus: upstream.status,
        usage: ok ? usage : null,
        latencyMs: Date.now() - startedAt,
        keySource: resolved.source,
      });

    const recordUsage = async (usage: DeepSeekUsage | null, responseModel?: string | null) => {
      if (!usage || !executionId) return;
      // Prefer the model DeepSeek actually served (aliases resolved), else the request's.
      const served = canonicalModel(responseModel ?? model);
      try {
        await svc.recordModelCall({
          executionId,
          companyId,
          userId,
          model: served,
          provider: 'deepseek',
          usage,
          recordEvent: !desktopOwnsTimeline,
        });
      } catch (e) {
        log.warn('proxy.usage.record_failed', { error: String(e) });
      }
    };

    // Non-streaming: forward JSON + read usage directly.
    if (!wantsStream || !upstream.body) {
      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
      res.send(text);
      let parsed: { usage?: DeepSeekUsage; model?: string } = {};
      if (upstream.ok) {
        try { parsed = JSON.parse(text) as { usage?: DeepSeekUsage; model?: string }; await recordUsage(parsed.usage ?? null, parsed.model ?? null); } catch { /* ignore */ }
      }
      audit(upstream.ok, parsed.usage ?? null, parsed.model ?? null);
      return;
    }

    // Streaming: pipe SSE straight through while capturing the usage chunk.
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    let interrupted = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          res.write(Buffer.from(value));
          acc += decoder.decode(value, { stream: true });
        }
      }
    } catch (e) {
      interrupted = true; // client disconnect or upstream stream abort after 200
      log.warn('proxy.stream.interrupted', { error: String(e) });
    } finally {
      res.end();
    }
    // A stream that broke mid-flight isn't a clean success — don't count it as an
    // allowed 200 in the audit/metrics, and don't trust a partial usage chunk.
    const ok = upstream.ok && !interrupted;
    const final = ok ? extractFinal(acc) : { usage: null, model: null };
    if (ok) await recordUsage(final.usage, final.model);
    audit(ok, final.usage, final.model, interrupted ? 'stream_interrupted' : undefined);
  });

  return router;
}
