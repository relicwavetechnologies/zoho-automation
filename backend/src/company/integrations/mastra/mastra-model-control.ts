import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';

import config from '../../../config';
import { aiModelControlService, type AiControlTargetKey } from '../../ai-models';

const googleClient = createGoogleGenerativeAI({
  apiKey: config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined,
});

export const MASTRA_AGENT_TARGETS = {
  supervisorAgent: 'mastra.supervisor',
  zohoAgent: 'mastra.zoho-specialist',
  outreachAgent: 'mastra.outreach',
  searchAgent: 'mastra.search',
  synthesisAgent: 'mastra.synthesis',
} as const;

export type MastraAgentTargetId = keyof typeof MASTRA_AGENT_TARGETS;

export const resolveMastraLanguageModel = async (targetKey: AiControlTargetKey) => {
  const resolved = await aiModelControlService.resolveTarget(targetKey);
  if (resolved.effectiveProvider === 'google') {
    return googleClient(resolved.effectiveModelId);
  }
  return openai(resolved.effectiveModelId);
};

export const buildMastraProviderOptions = async (targetKey: AiControlTargetKey) => {
  const resolved = await aiModelControlService.resolveTarget(targetKey);
  if (resolved.effectiveProvider !== 'google' || !resolved.effectiveThinkingLevel) {
    return undefined;
  }

  return {
    google: {
      thinkingConfig: {
        thinkingLevel: resolved.effectiveThinkingLevel,
      },
    },
  };
};

export const buildMastraAgentRunOptions = async (
  targetKey: AiControlTargetKey,
  base: Record<string, unknown> = {},
) => {
  const providerOptions = await buildMastraProviderOptions(targetKey);
  if (!providerOptions) {
    return base;
  }
  return {
    ...base,
    providerOptions,
  };
};
