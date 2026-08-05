/**
 * LLM proxy service — the guardrails + authoritative-usage brain behind the
 * desktop/Lark→backend→provider proxy.
 *
 *   gate()            — block / budget / rate / model-allow decision, pre-forward
 *   ensureRun()       — group completions into an ExecutionRun by correlation id
 *   recordToolResults() — reconstruct tool steps from the request `messages`
 *   recordModelCall() — record the turn's model call + AUTHORITATIVE token usage
 *
 * Cost is never stored — we persist the provider's token split; every read path
 * prices it via pricing.ts (Track B). This replaces PI self-reported usage.
 */

import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { ExecutionRepository } from '../../infrastructure/persistence/execution.repository';
import { TokenUsageService } from '../observability/token-usage.service';
import { costUsd, DEFAULT_ALLOWED_MODELS } from '../observability/pricing';

export interface GateInput {
  companyId: string;
  userId:    string;
  model:     string;
}
export interface GateResult {
  allow:   boolean;
  status?: number;   // HTTP status when denied
  reason?: string;
}

/** OpenAI-compatible provider `usage` object, including optional cache splits. */
export interface ProviderUsage {
  prompt_tokens?:            number;
  completion_tokens?:        number;
  prompt_cache_hit_tokens?:  number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?:    { cached_tokens?: number };
}

interface ChatMessage {
  role:          string;
  content?:      unknown;
  name?:         string;
  tool_call_id?: string;
  tool_calls?:   { id: string; function?: { name?: string; arguments?: string } }[];
}

const startOfMonth = (): Date => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; };
const asText = (content: unknown): string =>
  typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content);
const safeJson = (s: string | undefined): Record<string, unknown> => {
  if (!s) return {};
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return { raw: s }; }
};

export class LlmProxyService {
  private readonly repo: ExecutionRepository;
  private readonly tokens: TokenUsageService;
  // In-memory per-user request timestamps for rate limiting (single-instance).
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly prisma: PrismaClient, private readonly logger: Logger) {
    this.repo = new ExecutionRepository(prisma);
    this.tokens = new TokenUsageService(prisma, logger);
  }

  /** Pre-forward guardrail check. */
  /**
   * Which models this member may use, best first.
   *
   * Exposed so a caller can *choose* a model it is allowed to run instead of
   * asking for one and being refused. Lark used to pin Pro unconditionally, so
   * every member on the old Flash-only default got a 403
   * before the model saw a token.
   */
  async allowedModelsFor(userId: string): Promise<string[]> {
    const policy = await this.prisma.memberProxyPolicy.findUnique({ where: { userId } });
    if (policy?.blocked) return [];
    return policy && policy.allowedModels.length > 0 ? policy.allowedModels : [...DEFAULT_ALLOWED_MODELS];
  }

  async gate(input: GateInput): Promise<GateResult> {
    const policy = await this.prisma.memberProxyPolicy.findUnique({ where: { userId: input.userId } });

    if (policy?.blocked) return { allow: false, status: 403, reason: 'This account is blocked from the AI proxy.' };

    // `input.model` is already canonical (route normalizes). When no policy has been
    // set, members receive the shared default grant. Pro still requires an admin grant.
    const allowed: readonly string[] =
      policy && policy.allowedModels.length > 0 ? policy.allowedModels : DEFAULT_ALLOWED_MODELS;
    if (!allowed.includes(input.model)) {
      return { allow: false, status: 403, reason: `Model ${input.model} is not enabled for this account.` };
    }

    if (policy?.rateLimitRpm && policy.rateLimitRpm > 0 && !this.underRateLimit(input.userId, policy.rateLimitRpm)) {
      return { allow: false, status: 429, reason: 'Rate limit exceeded — slow down.' };
    }

    if (policy?.monthlyBudgetUsd != null) {
      const spent = await this.monthToDateSpend(input.companyId, input.userId);
      if (spent >= policy.monthlyBudgetUsd) {
        return { allow: false, status: 402, reason: `Monthly budget of $${policy.monthlyBudgetUsd.toFixed(2)} reached.` };
      }
    }

    return { allow: true };
  }

  private underRateLimit(userId: string, rpm: number): boolean {
    const now = Date.now();
    const windowStart = now - 60_000;
    const recent = (this.hits.get(userId) ?? []).filter((t) => t > windowStart);
    if (recent.length >= rpm) { this.hits.set(userId, recent); return false; }
    recent.push(now);
    this.hits.set(userId, recent);
    return true;
  }

  /** Priced month-to-date spend for a member (from authoritative token splits). */
  private async monthToDateSpend(companyId: string, userId: string): Promise<number> {
    const byModel = await this.prisma.aiTokenUsage.groupBy({
      by:      ['modelId'],
      where:   { companyId, userId, createdAt: { gte: startOfMonth() } },
      _sum:    { actualInputTokens: true, cacheReadInputTokens: true, actualOutputTokens: true },
      orderBy: { modelId: 'asc' },
    });
    let sum = 0;
    for (const m of byModel) {
      sum += costUsd(m.modelId, {
        cacheMissIn: m._sum.actualInputTokens ?? 0,
        cacheHitIn:  m._sum.cacheReadInputTokens ?? 0,
        output:      m._sum.actualOutputTokens ?? 0,
      });
    }
    return sum;
  }

  /** Find-or-create the ExecutionRun this completion belongs to. */
  async ensureRun(input: {
    runId: string;
    companyId: string;
    userId: string;
    channel?: string;
    agentTarget?: string;
  }): Promise<string> {
    return this.repo.findOrCreateByRequestId({
      requestId:  input.runId,
      companyId:  input.companyId,
      userId:     input.userId,
      channel:    input.channel ?? 'desktop',
      entrypoint: 'pi',
      ...(input.agentTarget ? { agentTarget: input.agentTarget } : {}),
    });
  }

  /**
   * Reconstruct tool steps from the request messages: the tool results trailing
   * the last assistant-with-tool_calls are this turn's *new* results (older ones
   * are no longer trailing on subsequent requests, so this dedupes naturally).
   */
  async recordToolResults(executionId: string, messages: ChatMessage[]): Promise<void> {
    let lastAssistant = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) { lastAssistant = i; break; }
    }
    if (lastAssistant < 0) return;

    const calls = new Map((messages[lastAssistant]!.tool_calls ?? []).map((c) => [c.id, c]));
    for (let i = lastAssistant + 1; i < messages.length; i += 1) {
      const m = messages[i];
      if (!m || m.role !== 'tool') continue;
      const call = m.tool_call_id ? calls.get(m.tool_call_id) : undefined;
      const toolName = call?.function?.name ?? m.name ?? 'tool';
      const input = safeJson(call?.function?.arguments);
      const sensitive = isShopifyInvocation(toolName, input);
      const output = sensitive ? '[REDACTED: governed Shopify result]' : asText(m.content);
      const storedInput = sensitive ? shopifyTraceMetadata(input) : input;
      const isError = /"?error"?\s*[:=]/i.test(output) && /error/i.test(output.slice(0, 200));
      const seq = await this.repo.nextSequence(executionId);
      await this.repo.appendEvent({
        executionId, sequence: seq, phase: 'execute', eventType: 'tool_result',
        actorType: 'tool', actorKey: toolName, title: toolName, status: isError ? 'error' : 'ok',
        payload: { input: storedInput, output, isError },
      });
      await this.repo.appendStepResult({
        executionId, sequence: seq, toolName, actorKey: toolName, success: !isError,
        status: isError ? 'error' : 'ok',
        rawOutput: { input: storedInput, output },
      });
    }
  }

  /** Record the turn's model call + authoritative token usage (DeepSeek's own numbers). */
  async recordModelCall(input: {
    executionId: string;
    companyId:   string;
    userId:      string;
    model:       string;
    provider:    string;
    usage:       ProviderUsage;
    agentTarget?: string;
    channel?:    string;
    threadId?:   string;
    mode?:       string;
    recordEvent?: boolean;
  }): Promise<void> {
    const u = input.usage;
    const cacheHit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheMiss = u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - cacheHit);
    const output = u.completion_tokens ?? 0;

    if (input.recordEvent !== false) {
      const seq = await this.repo.nextSequence(input.executionId);
      await this.repo.appendEvent({
        executionId: input.executionId, sequence: seq, phase: 'model', eventType: 'model_call',
        actorType: 'model', actorKey: input.model, title: input.model, status: 'ok',
        payload: { provider: input.provider, model: input.model, usage: { input: cacheMiss, output, cacheRead: cacheHit } },
      });
    }

    await this.tokens.recordForRun({
      executionRunId: input.executionId,
      companyId:      input.companyId,
      userId:         input.userId,
      agentTarget:    input.agentTarget ?? 'pi',
      modelId:        input.model,
      provider:       input.provider,
      channel:        input.channel ?? 'desktop',
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      actualInputTokens:    cacheMiss,
      actualOutputTokens:   output,
      cacheReadInputTokens: cacheHit,
    });
  }

  /**
   * Record a small backend-owned auxiliary completion that deliberately has no
   * user-visible execution run (for example, a desktop chat title). It still
   * contributes to the member's budget and token reporting, without adding a
   * misleading agent trace to the conversation timeline.
   */
  async recordAuxiliaryUsage(input: {
    companyId: string;
    userId: string;
    model: string;
    provider: string;
    usage: ProviderUsage;
    agentTarget: string;
    channel: string;
    threadId?: string;
    mode?: string;
  }): Promise<void> {
    const cacheHit = input.usage.prompt_cache_hit_tokens
      ?? input.usage.prompt_tokens_details?.cached_tokens
      ?? 0;
    const cacheMiss = input.usage.prompt_cache_miss_tokens
      ?? Math.max(0, (input.usage.prompt_tokens ?? 0) - cacheHit);
    const output = input.usage.completion_tokens ?? 0;

    try {
      await this.prisma.aiTokenUsage.create({
        data: {
          companyId: input.companyId,
          userId: input.userId,
          agentTarget: input.agentTarget,
          modelId: input.model,
          provider: input.provider,
          channel: input.channel,
          mode: input.mode ?? 'fast',
          actualInputTokens: cacheMiss,
          actualOutputTokens: output,
          cacheReadInputTokens: cacheHit,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
      });
    } catch (e) {
      this.logger.warn('proxy.auxiliary_usage.record_failed', {
        agentTarget: input.agentTarget,
        error: String(e),
      });
    }
  }

  /**
   * Append one audit row for a proxied request (the Guardrails feed + metrics).
   * Best-effort — a logging failure must never affect the caller's response.
   */
  async recordAudit(input: {
    companyId:    string;
    userId:       string;
    executionId?: string | null;
    model:        string;
    decision:     'allowed' | 'denied';
    reason?:      string | undefined;
    httpStatus:   number;
    usage?:       ProviderUsage | null;
    latencyMs:    number;
    keySource?:   string | null;
    channel?:     string;
    provider?:    string;
    agentTarget?: string;
  }): Promise<void> {
    try {
      const u = input.usage;
      const cacheHit = u ? (u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0) : 0;
      const cacheMiss = u ? (u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - cacheHit)) : 0;
      const output = u?.completion_tokens ?? 0;
      await this.prisma.proxyRequestLog.create({
        data: {
          companyId:       input.companyId,
          userId:          input.userId,
          executionRunId:  input.executionId ?? null,
          model:           input.model,
          decision:        input.decision,
          reason:          input.reason ?? null,
          httpStatus:      input.httpStatus,
          cacheHitTokens:  cacheHit,
          cacheMissTokens: cacheMiss,
          outputTokens:    output,
          latencyMs:       Math.max(0, Math.round(input.latencyMs)),
          keySource:       input.keySource ?? null,
          channel:         input.channel ?? 'desktop',
          provider:        input.provider ?? 'deepseek',
          agentTarget:     input.agentTarget ?? 'pi',
        },
      });
    } catch (e) {
      this.logger.warn('proxy.audit.record_failed', { error: String(e) });
    }
  }
}

function isShopifyInvocation(toolName: string, input: Record<string, unknown>): boolean {
  const payload = input['payload'];
  const payloadToolId = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)['toolId']
    : undefined;
  return [toolName, input['toolId'], payloadToolId]
    .some(value => typeof value === 'string' && value.startsWith('shopify'));
}

function shopifyTraceMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const payload = input['payload'];
  const payloadToolId = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)['toolId']
    : undefined;
  const toolId = typeof input['toolId'] === 'string' ? input['toolId'] : payloadToolId;
  return {
    ...(typeof input['op'] === 'string' ? { op: input['op'] } : {}),
    ...(typeof toolId === 'string' ? { toolId } : {}),
    redacted: true,
  };
}
