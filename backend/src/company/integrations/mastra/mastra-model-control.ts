import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';

import config from '../../../config';
import { aiModelControlService, type AiControlTargetKey } from '../../ai-models';

const googleClient = createGoogleGenerativeAI({
  apiKey: config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined,
});

export const MASTRA_AGENT_TARGETS = {
  ackAgent: 'mastra.ack',
  plannerAgent: 'mastra.planner',
  supervisorAgent: 'mastra.supervisor',
  zohoAgent: 'mastra.zoho-specialist',
  outreachAgent: 'mastra.outreach',
  searchAgent: 'mastra.search',
  larkDocAgent: 'mastra.lark-doc',
  synthesisAgent: 'mastra.synthesis',
} as const;

export type MastraAgentTargetId = keyof typeof MASTRA_AGENT_TARGETS;

import { AI_MODEL_CATALOG } from '../../ai-models/catalog';

export const resolveMastraLanguageModel = async (targetKey: AiControlTargetKey, mode?: 'fast' | 'high') => {
  const resolved = await aiModelControlService.resolveTarget(targetKey);
  
  let effectiveProvider = resolved.effectiveProvider;
  let effectiveModelId = resolved.effectiveModelId;

  if (mode === 'fast') {
    effectiveProvider = resolved.fastEffectiveProvider || effectiveProvider;
    effectiveModelId = resolved.fastEffectiveModelId || effectiveModelId;
  }

  if (effectiveProvider === 'google') {
    return googleClient(effectiveModelId);
  }
  return openai(effectiveModelId);
};

export const buildMastraProviderOptions = async (targetKey: AiControlTargetKey, mode?: 'fast' | 'high') => {
  const resolved = await aiModelControlService.resolveTarget(targetKey);
  const provider = mode === 'fast' ? (resolved.fastEffectiveProvider || resolved.effectiveProvider) : resolved.effectiveProvider;
  const thinkingLevel = mode === 'fast' ? (resolved.fastEffectiveThinkingLevel || resolved.effectiveThinkingLevel) : resolved.effectiveThinkingLevel;

  if (provider !== 'google' || !thinkingLevel) {
    return undefined;
  }

  return {
    google: {
      thinkingConfig: {
        thinkingLevel: thinkingLevel,
      },
    },
  };
};

export const buildMastraAgentRunOptions = async (
  targetKey: AiControlTargetKey,
  base: Record<string, unknown> = {},
  mode?: 'fast' | 'high',
) => {
  const providerOptions = await buildMastraProviderOptions(targetKey, mode);
  if (!providerOptions) {
    return base;
  }
  return {
    ...base,
    providerOptions,
  };
};
