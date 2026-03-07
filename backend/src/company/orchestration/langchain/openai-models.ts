import { ChatGoogle } from '@langchain/google';
import { ChatOpenAI } from '@langchain/openai';

import config from '../../../config';
import { aiModelControlService, type AiControlTargetKey, type AiModelProvider } from '../../ai-models';
import { logger } from '../../../utils/logger';

export type OrchestrationModelKey = 'router' | 'planner' | 'synthesis';
type SupportedChatModel = ChatOpenAI | ChatGoogle;
const GROQ_INVOKE_TIMEOUT_MS = 3_000;

const TARGET_BY_KEY: Record<OrchestrationModelKey, AiControlTargetKey> = {
  router: 'langgraph.router',
  planner: 'langgraph.planner',
  synthesis: 'langgraph.synthesis',
};

const TARGET_CACHE_ALIASES: Partial<Record<AiControlTargetKey, string>> = {
  'langgraph.router': 'router',
  'langgraph.planner': 'planner',
  'langgraph.synthesis': 'synthesis',
  'langgraph.supervisor': 'supervisor',
};

const coerceTemperature = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0.1;
  }
  return Math.max(0, Math.min(1, value));
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
  enabled: boolean;
  groqEnabled: boolean;
  groqRouter: ChatOpenAI | null = null;
  supervisorModel: SupportedChatModel | null = null;
  modelCache = new Map<string, SupportedChatModel>();

  constructor() {
    this.enabled = Boolean(
      (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0) ||
      (config.GEMINI_API_KEY && config.GEMINI_API_KEY.trim().length > 0),
    );
    this.groqEnabled = Boolean(config.GROQ_API_KEY && config.GROQ_API_KEY.trim().length > 0);

    if (!this.enabled && !this.groqEnabled) {
      logger.warn('langchain.orchestration.disabled', {
        reason: 'OPENAI_API_KEY, GEMINI_API_KEY, and GROQ_API_KEY are all missing',
      });
    }

    if (this.groqEnabled) {
      this.groqRouter = new ChatOpenAI({
        model: config.GROQ_ROUTER_MODEL,
        temperature: 0,
        apiKey: config.GROQ_API_KEY,
        configuration: {
          baseURL: 'https://api.groq.com/openai/v1',
        },
      });
    }
  }

  isEnabled(): boolean {
    return this.enabled || this.groqEnabled;
  }

  private hasProviderCredentials(provider: AiModelProvider): boolean {
    if (provider === 'google') {
      return Boolean((config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim());
    }
    return Boolean((process.env.OPENAI_API_KEY || '').trim());
  }

  private async buildTargetModel(targetKey: AiControlTargetKey): Promise<{ cacheKey: string; model: SupportedChatModel }> {
    const alias = TARGET_CACHE_ALIASES[targetKey];
    if (alias) {
      const aliased = this.modelCache.get(alias);
      if (aliased) {
        return { cacheKey: alias, model: aliased };
      }
    }

    const resolved = await aiModelControlService.resolveTarget(targetKey);
    const cacheKey = [
      targetKey,
      resolved.effectiveProvider,
      resolved.effectiveModelId,
      resolved.effectiveThinkingLevel ?? '',
    ].join(':');
    const cached = this.modelCache.get(cacheKey);
    if (cached) {
      return { cacheKey, model: cached };
    }

    if (!this.hasProviderCredentials(resolved.effectiveProvider)) {
      throw new Error(`Missing credentials for provider ${resolved.effectiveProvider}`);
    }

    const model: SupportedChatModel =
      resolved.effectiveProvider === 'google'
        ? new ChatGoogle({
          model: resolved.effectiveModelId,
          apiKey: config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
          thinkingLevel: resolved.effectiveThinkingLevel,
        })
        : new ChatOpenAI({
          model: resolved.effectiveModelId,
          temperature: coerceTemperature(config.OPENAI_TEMPERATURE),
        });

    this.modelCache.set(cacheKey, model);
    if (targetKey === 'langgraph.supervisor') {
      this.supervisorModel = model;
    }
    return { cacheKey, model };
  }

  private async invokeTarget(targetKey: AiControlTargetKey, prompt: string): Promise<string | null> {
    try {
      const { model } = await this.buildTargetModel(targetKey);
      const response = await model.invoke(prompt);
      const text = extractText(response.content).trim();
      return text.length > 0 ? text : null;
    } catch (error) {
      logger.warn('langchain.target.invoke_failed', {
        targetKey,
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
      return null;
    }
  }

  private async invokeGroq(prompt: string): Promise<string | null> {
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
      logger.warn('langchain.groq.invoke_failed', {
        reason: error instanceof Error ? error.message : 'unknown_error',
        timedOut: error instanceof Error && error.name === 'TimeoutError',
      });
      return null;
    }
  }

  async invokeTier1(prompt: string): Promise<string | null> {
    let resolved: Awaited<ReturnType<typeof aiModelControlService.resolveTarget>> | null = null;
    try {
      resolved = await aiModelControlService.resolveTarget('langgraph.router');
    } catch (error) {
      logger.warn('langchain.router.resolve_failed', {
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
    }
    if ((!resolved || resolved.source === 'default') && this.groqEnabled) {
      const fastPath = await this.invokeGroq(prompt);
      if (fastPath) {
        return fastPath;
      }
    }
    return this.invokeTarget('langgraph.router', prompt);
  }

  async invokeSupervisor(prompt: string): Promise<string | null> {
    const output = await this.invokeTarget('langgraph.supervisor', prompt);
    if (output) {
      return output;
    }
    if (this.groqEnabled) {
      return this.invokeGroq(prompt);
    }
    return null;
  }

  async invokePrompt(key: OrchestrationModelKey, prompt: string): Promise<string | null> {
    const targetKey = TARGET_BY_KEY[key];
    let resolved: Awaited<ReturnType<typeof aiModelControlService.resolveTarget>> | null = null;
    try {
      resolved = await aiModelControlService.resolveTarget(targetKey);
    } catch (error) {
      logger.warn('langchain.target.resolve_failed', {
        targetKey,
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
    }

    if (key === 'router' && (!resolved || resolved.source === 'default') && this.groqEnabled) {
      const fastPath = await this.invokeGroq(prompt);
      if (fastPath) {
        return fastPath;
      }
    }

    return this.invokeTarget(targetKey, prompt);
  }
}

export const openAiOrchestrationModels = new OpenAiOrchestrationModels();
