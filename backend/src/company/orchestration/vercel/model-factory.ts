import { createGoogleGenerativeAI } from '@ai-sdk/google';

import config from '../../../config';
const googleClient = createGoogleGenerativeAI({
  apiKey: config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined,
});

const VERCEL_MODELS: Record<'fast' | 'high' | 'xtreme', { modelId: string; thinkingLevel: 'medium' | 'high' | 'none' }> = {
  fast: { modelId: 'gemini-3.1-flash-lite-preview', thinkingLevel: 'medium' },
  high: { modelId: 'gemini-3.1-flash-lite-preview', thinkingLevel: 'high' },
  xtreme: { modelId: 'gemini-3.0-flash', thinkingLevel: 'high' },
};

export const resolveVercelLanguageModel = async (
  mode: 'fast' | 'high' | 'xtreme' = 'high',
) => {
  const configForMode = VERCEL_MODELS[mode] ?? VERCEL_MODELS.high;
  return {
    model: googleClient(configForMode.modelId),
    effectiveModelId: configForMode.modelId,
    effectiveProvider: 'google',
    thinkingLevel: configForMode.thinkingLevel,
  };
};
