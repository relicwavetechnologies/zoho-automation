import { wrapLanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

import config from '../../../config';
import { logger } from '../../../utils/logger';

const GOOGLE_PRIMARY_MODEL_ID = 'gemini-3.1-flash-lite-preview';
const GOOGLE_FALLBACK_MODEL_ID = 'gemini-2.5-flash-lite';

const googleClient = createGoogleGenerativeAI({
  apiKey: config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined,
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const getProviderErrorStatus = (error: unknown): number | undefined =>
  typeof (error as { status?: unknown })?.status === 'number'
    ? ((error as { status: number }).status)
    : typeof (error as { response?: { status?: unknown } })?.response?.status === 'number'
      ? ((error as { response: { status: number } }).response.status)
      : undefined;

const GOOGLE_CAPACITY_ERROR_FRAGMENTS = [
  'high demand',
  'resource exhausted',
  'resource_exhausted',
  'overloaded',
  'temporarily unavailable',
  'try again later',
  'capacity',
  'quota exceeded',
] as const;

const getGoogleCapacityReason = (error: unknown, seen = new Set<unknown>()): string | null => {
  if (!error || seen.has(error)) {
    return null;
  }
  seen.add(error);

  const status = getProviderErrorStatus(error);
  if (status === 429 || status === 503) {
    return `status_${status}`;
  }

  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  const normalizedMessage = message.trim().toLowerCase();
  if (
    normalizedMessage &&
    GOOGLE_CAPACITY_ERROR_FRAGMENTS.some((fragment) => normalizedMessage.includes(fragment))
  ) {
    return message.trim();
  }

  const record = asRecord(error);
  if (!record) {
    return null;
  }

  for (const key of ['cause', 'error', 'lastError']) {
    const reason = getGoogleCapacityReason(record[key], seen);
    if (reason) {
      return reason;
    }
  }

  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) {
      const reason = getGoogleCapacityReason(nested, seen);
      if (reason) {
        return reason;
      }
    }
  }

  return null;
};

const stripGoogleThinkingConfig = <T extends Record<string, any>>(params: T): T => {
  const providerOptions = params?.providerOptions;
  if (!providerOptions || typeof providerOptions !== 'object' || !providerOptions.google) {
    return params;
  }

  const googleOptions = providerOptions.google;
  if (!googleOptions || typeof googleOptions !== 'object' || !('thinkingConfig' in googleOptions)) {
    return params;
  }

  const { thinkingConfig: _thinkingConfig, ...nextGoogleOptions } = googleOptions;
  return {
    ...params,
    providerOptions: {
      ...providerOptions,
      google: nextGoogleOptions,
    },
  };
};

const buildGoogleLanguageModel = (modelId: string) => {
  const baseModel = googleClient(modelId);
  if (modelId !== GOOGLE_PRIMARY_MODEL_ID) {
    return baseModel;
  }

  return wrapLanguageModel({
    model: baseModel,
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        try {
          return await doGenerate();
        } catch (error) {
          const fallbackReason = getGoogleCapacityReason(error);
          if (!fallbackReason) {
            throw error;
          }
          logger.warn('ai.google.model_fallback', {
            fromModelId: GOOGLE_PRIMARY_MODEL_ID,
            toModelId: GOOGLE_FALLBACK_MODEL_ID,
            operation: 'generate',
            reason: fallbackReason,
          });
          return googleClient(GOOGLE_FALLBACK_MODEL_ID).doGenerate(
            stripGoogleThinkingConfig(params),
          );
        }
      },
      wrapStream: async ({ doStream, params }) => {
        try {
          return await doStream();
        } catch (error) {
          const fallbackReason = getGoogleCapacityReason(error);
          if (!fallbackReason) {
            throw error;
          }
          logger.warn('ai.google.model_fallback', {
            fromModelId: GOOGLE_PRIMARY_MODEL_ID,
            toModelId: GOOGLE_FALLBACK_MODEL_ID,
            operation: 'stream',
            reason: fallbackReason,
          });
          return googleClient(GOOGLE_FALLBACK_MODEL_ID).doStream(
            stripGoogleThinkingConfig(params),
          );
        }
      },
    },
  });
};

const VERCEL_MODELS: Record<
  'fast' | 'high',
  {
    modelId: string;
    thinkingLevel: 'minimal' | 'low' | 'medium' | 'high';
    includeThoughts: boolean;
  }
> = {
  fast: {
    modelId: GOOGLE_PRIMARY_MODEL_ID,
    thinkingLevel: 'low',
    includeThoughts: false,
  },
  high: {
    modelId: GOOGLE_PRIMARY_MODEL_ID,
    thinkingLevel: 'low',
    includeThoughts: false,
  },
};

export const resolveVercelLanguageModel = async (
  mode: 'fast' | 'high' = 'high',
) => {
  const configForMode = VERCEL_MODELS[mode] ?? VERCEL_MODELS.high;
  return {
    model: buildGoogleLanguageModel(configForMode.modelId),
    effectiveModelId: configForMode.modelId,
    effectiveProvider: 'google',
    thinkingLevel: configForMode.thinkingLevel,
    includeThoughts: configForMode.includeThoughts,
  };
};

export const resolveVercelChildRouterModel = async () => ({
  model: buildGoogleLanguageModel(GOOGLE_PRIMARY_MODEL_ID),
  effectiveModelId: GOOGLE_PRIMARY_MODEL_ID,
  effectiveProvider: 'google' as const,
  thinkingLevel: 'low' as const,
  includeThoughts: false as const,
});
