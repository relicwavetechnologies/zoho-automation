import { createGoogleGenerativeAI } from '@ai-sdk/google';

import config from '../../../config';

const googleClient = createGoogleGenerativeAI({
  apiKey: config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined,
});

const VERCEL_MODELS: Record<
  'fast' | 'high',
  {
    modelId: string;
    thinkingLevel: 'minimal' | 'low' | 'medium' | 'high';
    includeThoughts: boolean;
    thinkingBudget: number;
  }
> = {
  fast: {
    modelId: 'gemini-3.1-flash-lite-preview',
    thinkingLevel: 'minimal',
    includeThoughts: false,
    thinkingBudget: 0,
  },
  high: {
    modelId: 'gemini-3.1-flash-lite-preview',
    thinkingLevel: 'minimal',
    includeThoughts: false,
    thinkingBudget: 0,
  },
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
    includeThoughts: configForMode.includeThoughts,
    thinkingBudget: configForMode.thinkingBudget,
  };
};

export const resolveVercelChildRouterModel = async () => ({
  model: googleClient('gemini-3.1-flash-lite-preview'),
  effectiveModelId: 'gemini-3.1-flash-lite-preview',
  effectiveProvider: 'google' as const,
  thinkingLevel: 'minimal' as const,
  includeThoughts: false as const,
  thinkingBudget: 0 as const,
});
