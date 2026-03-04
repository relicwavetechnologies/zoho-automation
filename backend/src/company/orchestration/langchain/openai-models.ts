import { ChatOpenAI } from '@langchain/openai';

import config from '../../../config';
import { logger } from '../../../utils/logger';

export type OrchestrationModelKey = 'router' | 'planner' | 'synthesis';

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

  private readonly modelCache = new Map<OrchestrationModelKey, ChatOpenAI>();

  constructor() {
    this.enabled = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0);
    if (!this.enabled) {
      logger.warn('langchain.openai.disabled', {
        reason: 'OPENAI_API_KEY missing',
      });
    }
  }

  isEnabled(): boolean {
    return this.enabled;
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

  async invokePrompt(key: OrchestrationModelKey, prompt: string): Promise<string | null> {
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
