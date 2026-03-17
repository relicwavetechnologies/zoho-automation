export type AiModelProvider = 'google' | 'openai' | 'groq';
export type AiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export type AiControlEngine = 'mastra';
export type AiControlTargetKind = 'supervisor' | 'specialist' | 'router' | 'planner' | 'synthesis' | 'ack';

export const AI_THINKING_LEVELS: AiThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];

export type AiControlTargetKey =
  | 'mastra.outreach'
  | 'mastra.synthesis';

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
    modelId: 'gemini-3.1-flash-lite-preview',
    label: 'Gemini 3.1 Flash-Lite Preview',
    description: 'Latest lightweight Gemini 3.1 preview for cheap, fast supervisor and search runs.',
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
    description: 'Stronger Gemini 3 fast model for supervision, routing, and complex tool selection.',
    preview: true,
    supportsThinking: true,
    speed: 'strong',
    cost: 'balanced',
    maxContextTokens: 1_048_576,
    outputReserveTokens: 32_768,
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
    key: 'mastra.outreach',
    engine: 'mastra',
    kind: 'specialist',
    label: 'Odin Outreach Specialist',
    description: 'SEO/outreach inventory filtering specialist for publisher discovery and ranking.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4.1-nano',
    fastDefaultProvider: 'openai',
    fastDefaultModelId: 'gpt-4.1-nano',
  },
  {
    key: 'mastra.synthesis',
    engine: 'mastra',
    kind: 'synthesis',
    label: 'Odin Synthesis',
    description: 'Response-polishing agent used to turn grounded records into concise business answers.',
    defaultProvider: 'google',
    defaultModelId: 'gemini-3.1-flash-lite-preview',
    fastDefaultProvider: 'google',
    fastDefaultModelId: 'gemini-3.1-flash-lite-preview',
  },
];

export const AI_CONTROL_TARGET_MAP = new Map(
  AI_CONTROL_TARGETS.map((target) => [target.key, target] as const),
);

export const isAiThinkingLevel = (value: string): value is AiThinkingLevel =>
  AI_THINKING_LEVELS.includes(value as AiThinkingLevel);
