import { extractJsonObject } from '../langchain';
import type { LangGraphSynthesisSource, LangGraphSynthesisState } from './langgraph.types';

const normalizeText = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
};

const sanitizeFallbackSynthesis = (
  fallback: LangGraphSynthesisState,
): LangGraphSynthesisState => {
  const text = normalizeText(fallback.text);
  if (text.length > 0) {
    return {
      ...fallback,
      text,
    };
  }

  return {
    ...fallback,
    text: fallback.taskStatus === 'failed'
      ? 'Request failed and no additional synthesis content is available.'
      : 'Request completed successfully.',
  };
};

export type SynthesisResolution = {
  synthesis: LangGraphSynthesisState;
  source: LangGraphSynthesisSource;
  validationErrors: string[];
};

export const resolveSynthesisContract = (input: {
  rawLlmOutput: string | null;
  deterministicFallback: LangGraphSynthesisState;
}): SynthesisResolution => {
  const fallback = sanitizeFallbackSynthesis(input.deterministicFallback);

  if (!input.rawLlmOutput || input.rawLlmOutput.trim().length === 0) {
    return {
      synthesis: fallback,
      source: 'deterministic_fallback',
      validationErrors: ['synthesis model output is empty'],
    };
  }

  const parsed = extractJsonObject(input.rawLlmOutput);
  if (!parsed) {
    return {
      synthesis: fallback,
      source: 'deterministic_fallback',
      validationErrors: ['synthesis model output is not valid JSON object'],
    };
  }

  const text = normalizeText(parsed.text);
  if (text.length === 0) {
    return {
      synthesis: fallback,
      source: 'deterministic_fallback',
      validationErrors: ['synthesis text must be non-empty'],
    };
  }

  const status = parsed.taskStatus;
  if (status !== 'done' && status !== 'failed') {
    return {
      synthesis: fallback,
      source: 'deterministic_fallback',
      validationErrors: ['synthesis taskStatus must be done or failed'],
    };
  }

  return {
    synthesis: {
      text,
      taskStatus: status,
    },
    source: 'llm',
    validationErrors: [],
  };
};
