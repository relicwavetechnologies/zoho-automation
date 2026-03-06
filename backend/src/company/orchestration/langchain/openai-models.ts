import { ChatOpenAI } from '@langchain/openai';

import config from '../../../config';
import { logger } from '../../../utils/logger';

export type OrchestrationModelKey = 'router' | 'planner' | 'synthesis';
const GROQ_INVOKE_TIMEOUT_MS = 3_000;

const coerceTemperature = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0.1;
  }
  return Math.max(0, Math.min(1, value));
};

const readModelName = (key: OrchestrationModelKey): string => {
  if (key === 'router') {
    return config.OPENAI_ROUTER_MODEL;
  }
  if (key === 'planner') {
    return config.OPENAI_PLANNER_MODEL;
  }
  return config.OPENAI_SYNTHESIS_MODEL;
};

const extractText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((chunk) => {
        if (typeof chunk === 'string') {
          return chunk;
        }
        if (chunk && typeof chunk === 'object' && 'text' in chunk && typeof (chunk as { text?: unknown }).text === 'string') {
          return (chunk as { text: string }).text;
        }
        return '';
      })
      .join(' ')
      .trim();
  }

  return '';
};

class OpenAiOrchestrationModels {
  private readonly enabled: boolean;
  private readonly groqEnabled: boolean;
  private readonly groqRouter: ChatOpenAI | null = null;
  private readonly supervisorModel: ChatOpenAI | null = null;
  private readonly modelCache = new Map<OrchestrationModelKey, ChatOpenAI>();

  constructor() {
    this.enabled = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0);
    this.groqEnabled = Boolean(config.GROQ_API_KEY && config.GROQ_API_KEY.trim().length > 0);

    if (!this.enabled && !this.groqEnabled) {
      logger.warn('langchain.orchestration.disabled', {
        reason: 'Both OPENAI_API_KEY and GROQ_API_KEY missing',
      });
    }

    if (this.groqEnabled) {
      this.groqRouter = new ChatOpenAI({
        model: config.GROQ_ROUTER_MODEL,
        temperature: 0, // deterministic for Tier-1 fast-path decisions
        apiKey: config.GROQ_API_KEY,
        configuration: {
          baseURL: 'https://api.groq.com/openai/v1',
        },
      });
    }

    if (this.enabled) {
      this.supervisorModel = new ChatOpenAI({
        model: config.OPENAI_SUPERVISOR_MODEL,
        temperature: coerceTemperature(config.OPENAI_TEMPERATURE),
      });
    }
  }

  isEnabled(): boolean {
    return this.enabled || this.groqEnabled;
  }

  private getModel(key: OrchestrationModelKey): ChatOpenAI {
    const cached = this.modelCache.get(key);
    if (cached) {
      return cached;
    }

    const model = new ChatOpenAI({
      model: readModelName(key),
      temperature: coerceTemperature(config.OPENAI_TEMPERATURE),
    });

    this.modelCache.set(key, model);
    return model;
  }

  /**
   * Tier-1 fast path via Groq (~100ms, very cheap).
   * Times out after 3 seconds — gracefully falls through to full orchestration.
   * Returns raw text or null if unavailable/timed-out/errored.
   */
  async invokeTier1(prompt: string): Promise<string | null> {
    if (!this.groqEnabled || !this.groqRouter) {
      return null;
    }
    try {
      const response = await this.groqRouter.invoke(prompt, {
        signal: AbortSignal.timeout(GROQ_INVOKE_TIMEOUT_MS),
      });
      const text = extractText(response.content).trim();
      return text.length > 0 ? text : null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown_error';
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      logger.warn('langchain.groq.tier1.failed', {
        reason,
        timedOut: isTimeout,
      });
      return null;
    }
  }

  /**
   * Tier-2 supervisor boss via GPT-4o.
   * Decides which agent to call next, or returns FINISH with a NL reply.
   * Falls back to Groq if OpenAI is unavailable.
   */
  async invokeSupervisor(prompt: string): Promise<string | null> {
    if (!this.enabled || !this.supervisorModel) {
      if (this.groqEnabled && this.groqRouter) {
        try {
          const response = await this.groqRouter.invoke(prompt, {
            signal: AbortSignal.timeout(GROQ_INVOKE_TIMEOUT_MS),
          });
          const text = extractText(response.content).trim();
          return text.length > 0 ? text : null;
        } catch {
          return null;
        }
      }
      return null;
    }
    try {
      const response = await this.supervisorModel.invoke(prompt);
      const text = extractText(response.content).trim();
      return text.length > 0 ? text : null;
    } catch (error) {
      logger.warn('langchain.supervisor.invoke_failed', {
        model: config.OPENAI_SUPERVISOR_MODEL,
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
      return null;
    }
  }

  /**
   * General orchestration invoke (router / planner / synthesis).
   * Router tries Groq first, then falls back to OpenAI.
   */
  async invokePrompt(key: OrchestrationModelKey, prompt: string): Promise<string | null> {
    if (key === 'router' && this.groqEnabled && this.groqRouter) {
      try {
        const response = await this.groqRouter.invoke(prompt, {
          signal: AbortSignal.timeout(GROQ_INVOKE_TIMEOUT_MS),
        });
        const text = extractText(response.content).trim();
        if (text.length > 0) {
          return text;
        }
      } catch (error) {
        logger.warn('langchain.groq.invoke_failed', {
          modelKey: key,
          fallback: 'Attempting OpenAI fallback if possible',
          reason: error instanceof Error ? error.message : 'unknown_error',
          timedOut: error instanceof Error && error.name === 'TimeoutError',
        });
      }
    }

    if (!this.enabled) {
      return null;
    }

    try {
      const model = this.getModel(key);
      const response = await model.invoke(prompt);
      const text = extractText(response.content).trim();
      return text.length > 0 ? text : null;
    } catch (error) {
      logger.warn('langchain.openai.invoke_failed', {
        modelKey: key,
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
      return null;
    }
  }
}

export const openAiOrchestrationModels = new OpenAiOrchestrationModels();
