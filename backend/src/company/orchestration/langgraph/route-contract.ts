import { extractJsonObject } from '../langchain';
import { classifyComplexityLevel, detectRouteIntent } from '../routing-heuristics';
import type { LangGraphRouteFallbackReasonCode, LangGraphRouteState } from './langgraph.types';

export type RouteResolution = {
  route: LangGraphRouteState;
  source: 'llm' | 'heuristic_fallback';
  fallbackReasonCode?: LangGraphRouteFallbackReasonCode;
};

const isIntent = (value: unknown): value is LangGraphRouteState['intent'] =>
  value === 'zoho_read' || value === 'write_intent' || value === 'general';

const isExecutionMode = (value: unknown): value is LangGraphRouteState['executionMode'] =>
  value === 'sequential' || value === 'parallel' || value === 'mixed';

const isComplexityLevel = (value: unknown): value is LangGraphRouteState['complexityLevel'] =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;

const buildHeuristicFallback = (
  text: string,
  fallbackReasonCode: LangGraphRouteFallbackReasonCode,
): RouteResolution => ({
  route: {
    intent: detectRouteIntent(text),
    complexityLevel: classifyComplexityLevel(text),
    executionMode: 'sequential',
    source: 'heuristic_fallback',
    fallbackReasonCode,
  },
  source: 'heuristic_fallback',
  fallbackReasonCode,
});

export const buildRoutePrompt = (messageText: string): string =>
  [
    'You are Odin AI route classification.',
    'Classify the user request for orchestration and return JSON only.',
    'Required shape: {"intent":"zoho_read|write_intent|general","complexityLevel":1-5,"executionMode":"sequential|parallel|mixed"}',
    'Use `zoho_read` for CRM retrieval or Zoho analysis requests.',
    'Use `write_intent` for destructive or confirmation-worthy actions.',
    'Use `general` for everything else.',
    'Valid example: {"intent":"zoho_read","complexityLevel":3,"executionMode":"sequential"}',
    'Invalid example to avoid: I think this is general.',
    'Do not explain the classification.',
    `User: ${messageText}`,
  ].join('\n');

export const resolveRouteContract = (input: {
  rawLlmOutput: string | null;
  messageText: string;
}): RouteResolution => {
  if (!input.rawLlmOutput || input.rawLlmOutput.trim().length === 0) {
    return buildHeuristicFallback(input.messageText, 'llm_empty');
  }

  const parsed = extractJsonObject(input.rawLlmOutput);
  if (!parsed) {
    return buildHeuristicFallback(input.messageText, 'llm_non_json');
  }

  if (!isIntent(parsed.intent) || !isExecutionMode(parsed.executionMode)) {
    return buildHeuristicFallback(input.messageText, 'llm_invalid_enum');
  }

  if (!isComplexityLevel(parsed.complexityLevel)) {
    return buildHeuristicFallback(input.messageText, 'llm_invalid_range');
  }

  return {
    route: {
      intent: parsed.intent,
      complexityLevel: parsed.complexityLevel,
      executionMode: parsed.executionMode,
      source: 'llm',
    },
    source: 'llm',
  };
};
