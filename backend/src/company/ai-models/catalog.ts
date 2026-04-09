export type AiModelProvider = 'google' | 'openai' | 'groq';
export type AiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export type AiControlEngine = 'mastra';
export type AiControlTargetKind = 'supervisor' | 'specialist' | 'router' | 'planner' | 'synthesis' | 'ack';

export const AI_THINKING_LEVELS: AiThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];

export type AiControlTargetKey =
  | 'runtime.fast'
  | 'runtime.high';

export type AiModelCatalogEntry = {
  provider: AiModelProvider;
  modelId: string;
  label: string;
  description: string;
  preview?: boolean;
  supportsThinking?: boolean;
  speed: 'fast' | 'balanced' | 'strong';
  cost: 'cheap' | 'balanced' | 'premium';
  /** Maximum total tokens the model accepts in one request */
  maxContextTokens: number;
  /** Tokens to reserve for output generation + system prompt overhead */
  outputReserveTokens: number;
};

export type AiControlTargetDefinition = {
  key: AiControlTargetKey;
  engine: AiControlEngine;
  kind: AiControlTargetKind;
  label: string;
  description: string;
  defaultProvider: AiModelProvider;
  defaultModelId: string;
  defaultThinkingLevel?: AiThinkingLevel;
  fastDefaultProvider?: AiModelProvider;
  fastDefaultModelId?: string;
  fastDefaultThinkingLevel?: AiThinkingLevel;
  xtremeDefaultProvider?: AiModelProvider;
  xtremeDefaultModelId?: string;
  xtremeDefaultThinkingLevel?: AiThinkingLevel;
};

export const AI_MODEL_CATALOG: AiModelCatalogEntry[] = [
  {
    provider: 'google',
    modelId: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite',
    description: 'Lowest-cost stable Gemini option for high-volume and lightweight reasoning.',
    supportsThinking: true,
    speed: 'fast',
    cost: 'cheap',
    maxContextTokens: 1_048_576,
    outputReserveTokens: 32_768,
  },
  {
    provider: 'google',
    modelId: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    description: 'Balanced stable Gemini model with stronger quality than Flash-Lite.',
    supportsThinking: true,
    speed: 'balanced',
    cost: 'balanced',
    maxContextTokens: 1_048_576,
    outputReserveTokens: 32_768,
  },
  {
    provider: 'google',
    modelId: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    description: 'Most advanced stable Gemini 2.5 model for complex reasoning and coding tasks.',
    supportsThinking: true,
    speed: 'strong',
    cost: 'premium',
    maxContextTokens: 1_048_576,
    outputReserveTokens: 32_768,
  },
  {
    provider: 'google',
    modelId: 'gemini-3.1-flash-lite-preview',
    label: 'Gemini 3.1 Flash-Lite Preview',
    description: 'Current Gemini 3.1 Flash-Lite preview for cost-efficient, high-volume multimodal tasks.',
    preview: true,
    supportsThinking: true,
    speed: 'fast',
    cost: 'balanced',
    maxContextTokens: 1_048_576,
    outputReserveTokens: 32_768,
  },
  {
    provider: 'google',
    modelId: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash Preview',
    description: 'Current Gemini 3 Flash preview with frontier-class performance at Flash speed and pricing.',
    preview: true,
    supportsThinking: true,
    speed: 'strong',
    cost: 'balanced',
    maxContextTokens: 1_048_576,
    outputReserveTokens: 32_768,
  },
  {
    provider: 'google',
    modelId: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro Preview',
    description: 'Current Gemini 3.1 Pro preview for advanced reasoning, coding, and complex multimodal work.',
    preview: true,
    supportsThinking: true,
    speed: 'strong',
    cost: 'premium',
    maxContextTokens: 1_048_576,
    outputReserveTokens: 64_000,
  },
  {
    provider: 'openai',
    modelId: 'gpt-4.1-nano',
    label: 'GPT-4.1 Nano',
    description: 'Cheapest GPT-4.1 variant for classification, routing, and short tool outputs.',
    speed: 'fast',
    cost: 'cheap',
    maxContextTokens: 128_000,
    outputReserveTokens: 16_384,
  },
  {
    provider: 'openai',
    modelId: 'gpt-4.1-mini',
    label: 'GPT-4.1 Mini',
    description: 'Best OpenAI balance for tool calling, synthesis, and agent orchestration.',
    speed: 'balanced',
    cost: 'balanced',
    maxContextTokens: 128_000,
    outputReserveTokens: 16_384,
  },
  {
    provider: 'openai',
    modelId: 'gpt-4.1',
    label: 'GPT-4.1',
    description: 'Highest-quality OpenAI option in this control plane, with higher cost/latency.',
    speed: 'strong',
    cost: 'premium',
    maxContextTokens: 128_000,
    outputReserveTokens: 16_384,
  },
  {
    provider: 'groq',
    modelId: 'llama-90b',
    label: 'Groq Llama 3 90B',
    description: 'Ultra-fast synthesis and structuring model via Groq LPU.',
    speed: 'fast',
    cost: 'cheap',
    maxContextTokens: 8192,
    outputReserveTokens: 1024,
  },
  {
    provider: 'groq',
    modelId: 'llama-8b',
    label: 'Groq Llama 3 8B',
    description: 'Instant routing and acknowledgement via Groq LPU.',
    speed: 'fast',
    cost: 'cheap',
    maxContextTokens: 8192,
    outputReserveTokens: 1024,
  },
];

export const AI_MODEL_CATALOG_MAP = new Map(
  AI_MODEL_CATALOG.map((entry) => [`${entry.provider}:${entry.modelId}`, entry] as const),
);

export const AI_CONTROL_TARGETS: AiControlTargetDefinition[] = [
  {
    key: 'runtime.fast',
    engine: 'mastra',
    kind: 'specialist',
    label: 'Fast Runtime Model',
    description: 'Model used for routing, classification, and lightweight reasoning calls.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4o-mini',
    fastDefaultProvider: 'openai',
    fastDefaultModelId: 'gpt-4o-mini',
  },
  {
    key: 'runtime.high',
    engine: 'mastra',
    kind: 'synthesis',
    label: 'High Runtime Model',
    description: 'Model used for synthesis, supervision, and complex reasoning calls.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4o',
    fastDefaultProvider: 'openai',
    fastDefaultModelId: 'gpt-4o-mini',
  },
];

export const AI_CONTROL_TARGET_MAP = new Map(
  AI_CONTROL_TARGETS.map((target) => [target.key, target] as const),
);

export const isAiThinkingLevel = (value: string): value is AiThinkingLevel =>
  AI_THINKING_LEVELS.includes(value as AiThinkingLevel);
