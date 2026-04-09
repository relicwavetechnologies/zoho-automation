import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createGroq } from '@ai-sdk/groq';

import { aiModelControlService } from '../../ai-models';
import config from '../../../config';

const googleClient = createGoogleGenerativeAI({
  apiKey: config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined,
});

const openaiClient = createOpenAI({
  apiKey: config.OPENAI_API_KEY || undefined,
});

const groqClient = createGroq({
  apiKey: config.GROQ_API_KEY || undefined,
});

const resolveModelInstance = (
  provider: string,
  modelId: string,
) => {
  switch (provider) {
    case 'openai':
      return openaiClient(modelId);
    case 'groq':
      return groqClient(modelId);
    case 'google':
    default:
      return googleClient(modelId);
  }
};

const VERCEL_MODELS: Record<
  'fast' | 'high',
  {
    provider: string;
    modelId: string;
    thinkingLevel: 'minimal' | 'low' | 'medium' | 'high';
    includeThoughts: boolean;
  }
> = {
  fast: {
    provider: 'openai',
    modelId: config.OPENAI_ROUTER_MODEL || 'gpt-4o-mini',
    thinkingLevel: 'low',
    includeThoughts: false,
  },
  high: {
    provider: 'openai',
    modelId: config.OPENAI_SUPERVISOR_MODEL || 'gpt-4o',
    thinkingLevel: 'low',
    includeThoughts: false,
  },
};

export const resolveVercelLanguageModel = async (
  mode: 'fast' | 'high' = 'high',
  agentDefinition?: { modelId?: string | null; provider?: string | null },
) => {
  if (agentDefinition?.modelId && agentDefinition?.provider) {
    return {
      model: resolveModelInstance(
        agentDefinition.provider,
        agentDefinition.modelId,
      ),
      effectiveModelId: agentDefinition.modelId,
      effectiveProvider: agentDefinition.provider,
      thinkingLevel: 'low' as const,
      includeThoughts: false as const,
    };
  }

  try {
    const targetKey = mode === 'fast'
      ? 'runtime.fast'
      : 'runtime.high';
    const resolved = await aiModelControlService.resolveTarget(targetKey);

    const provider = resolved.effectiveProvider;
    const modelId = mode === 'fast'
      ? (resolved.fastEffectiveModelId ?? resolved.effectiveModelId)
      : resolved.effectiveModelId;
    const effectiveProvider = mode === 'fast'
      ? (resolved.fastEffectiveProvider ?? provider)
      : provider;

    return {
      model: resolveModelInstance(effectiveProvider, modelId),
      effectiveModelId: modelId,
      effectiveProvider,
      thinkingLevel: 'low' as const,
      includeThoughts: false as const,
    };
  } catch {
    const configForMode = VERCEL_MODELS[mode] ?? VERCEL_MODELS.high;
    return {
      model: resolveModelInstance(
        configForMode.provider,
        configForMode.modelId,
      ),
      effectiveModelId: configForMode.modelId,
      effectiveProvider: configForMode.provider,
      thinkingLevel: configForMode.thinkingLevel,
      includeThoughts: configForMode.includeThoughts,
    };
  }
};

export const resolveVercelChildRouterModel = async () => {
  const modelId = config.OPENAI_ROUTER_MODEL || 'gpt-4o-mini';
  return {
    model: openaiClient(modelId),
    effectiveModelId: modelId,
    effectiveProvider: 'openai' as const,
    thinkingLevel: 'low' as const,
    includeThoughts: false as const,
  };
};
