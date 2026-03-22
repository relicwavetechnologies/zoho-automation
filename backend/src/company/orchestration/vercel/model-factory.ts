import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';

import config from '../../../config';

const googleClient = createGoogleGenerativeAI({
  apiKey: config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined,
});
const groqClient = createOpenAI({
  apiKey: config.GROQ_API_KEY || undefined,
  baseURL: 'https://api.groq.com/openai/v1',
});

const VERCEL_MODELS: Record<'fast' | 'high', { modelId: string; thinkingLevel: 'low' | 'medium' }> = {
  fast: { modelId: 'gemini-3.1-flash-lite-preview', thinkingLevel: 'low' },
  high: { modelId: 'gemini-3.1-flash-lite-preview', thinkingLevel: 'medium' },
};

export const resolveVercelLanguageModel = async (
  mode: 'fast' | 'high' = 'high',
) => {
  const configForMode = VERCEL_MODELS[mode] ?? VERCEL_MODELS.high;
  return {
    model: googleClient(configForMode.modelId),
    effectiveModelId: configForMode.modelId,
    effectiveProvider: 'google',
    thinkingLevel: configForMode.thinkingLevel,
  };
};

export const resolveVercelChildRouterModel = async () => ({
  model: groqClient(config.GROQ_ROUTER_MODEL),
  effectiveModelId: config.GROQ_ROUTER_MODEL,
  effectiveProvider: 'groq' as const,
  thinkingLevel: 'none' as const,
});
