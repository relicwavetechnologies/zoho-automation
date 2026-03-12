export type AiModelProvider = 'google' | 'openai';
export type AiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export type AiControlEngine = 'mastra' | 'langgraph';
export type AiControlTargetKind = 'supervisor' | 'specialist' | 'router' | 'planner' | 'synthesis' | 'ack';

export const AI_THINKING_LEVELS: AiThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];

export type AiControlTargetKey =
  | 'mastra.ack'
  | 'mastra.planner'
  | 'mastra.supervisor'
  | 'mastra.zoho-specialist'
  | 'mastra.search'
  | 'mastra.outreach'
  | 'mastra.lark-doc'
  | 'mastra.synthesis'
  | 'langgraph.supervisor'
  | 'langgraph.router'
  | 'langgraph.planner'
  | 'langgraph.synthesis';

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
];

export const AI_MODEL_CATALOG_MAP = new Map(
  AI_MODEL_CATALOG.map((entry) => [`${entry.provider}:${entry.modelId}`, entry] as const),
);

export const AI_CONTROL_TARGETS: AiControlTargetDefinition[] = [
  {
    key: 'mastra.ack',
    engine: 'mastra',
    kind: 'ack',
    label: 'Mastra Acknowledgement',
    description: 'Low-latency AI acknowledgement used for placeholder/progress replies before the main supervisor finishes.',
    defaultProvider: 'google',
    defaultModelId: 'gemini-3.1-flash-lite-preview',
    defaultThinkingLevel: 'minimal',
    fastDefaultProvider: 'google',
    fastDefaultModelId: 'gemini-2.5-flash-lite',
  },
  {
    key: 'mastra.planner',
    engine: 'mastra',
    kind: 'planner',
    label: 'Mastra Planner',
    description: 'Desktop planning specialist that turns complex user requests into ordered execution plans and success criteria.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4.1-mini',
    fastDefaultProvider: 'openai',
    fastDefaultModelId: 'gpt-4.1-nano',
  },
  {
    key: 'mastra.supervisor',
    engine: 'mastra',
    kind: 'supervisor',
    label: 'Mastra Supervisor',
    description: 'Top-level Mastra orchestrator that routes across Zoho, outreach, and web search specialists.',
    defaultProvider: 'google',
    defaultModelId: 'gemini-3-flash-preview',
    defaultThinkingLevel: 'high',
    fastDefaultProvider: 'google',
    fastDefaultModelId: 'gemini-3.1-flash-lite-preview',
    fastDefaultThinkingLevel: 'medium',
  },
  {
    key: 'mastra.zoho-specialist',
    engine: 'mastra',
    kind: 'specialist',
    label: 'Mastra Zoho Specialist',
    description: 'CRM specialist for live Zoho reads and recovery fallback synthesis.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4.1-mini',
    fastDefaultProvider: 'openai',
    fastDefaultModelId: 'gpt-4.1-nano',
  },
  {
    key: 'mastra.search',
    engine: 'mastra',
    kind: 'specialist',
    label: 'Mastra Search Specialist',
    description: 'Serper-backed web research specialist with exact-page context extraction.',
    defaultProvider: 'google',
    defaultModelId: 'gemini-3.1-flash-lite-preview',
    defaultThinkingLevel: 'medium',
    fastDefaultProvider: 'google',
    fastDefaultModelId: 'gemini-2.5-flash-lite',
  },
  {
    key: 'mastra.outreach',
    engine: 'mastra',
    kind: 'specialist',
    label: 'Mastra Outreach Specialist',
    description: 'SEO/outreach inventory filtering specialist for publisher discovery and ranking.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4.1-nano',
    fastDefaultProvider: 'openai',
    fastDefaultModelId: 'gpt-4.1-nano',
  },
  {
    key: 'mastra.lark-doc',
    engine: 'mastra',
    kind: 'specialist',
    label: 'Mastra Lark Docs Specialist',
    description: 'Document creation specialist that formats grounded markdown and creates Lark Docs through the import API.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4.1-mini',
    fastDefaultProvider: 'openai',
    fastDefaultModelId: 'gpt-4.1-mini',
  },
  {
    key: 'mastra.synthesis',
    engine: 'mastra',
    kind: 'synthesis',
    label: 'Mastra Synthesis',
    description: 'Response-polishing agent used to turn grounded records into concise business answers.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4.1-mini',
    fastDefaultProvider: 'openai',
    fastDefaultModelId: 'gpt-4.1-nano',
  },
  {
    key: 'langgraph.supervisor',
    engine: 'langgraph',
    kind: 'supervisor',
    label: 'LangGraph Supervisor',
    description: 'Tier-2 planner/supervisor used when the LangGraph orchestration engine coordinates multiple agents.',
    defaultProvider: 'google',
    defaultModelId: 'gemini-3-flash-preview',
    defaultThinkingLevel: 'high',
    fastDefaultProvider: 'google',
    fastDefaultModelId: 'gemini-2.5-flash-lite',
  },
  {
    key: 'langgraph.router',
    engine: 'langgraph',
    kind: 'router',
    label: 'LangGraph Router',
    description: 'Low-latency intent/router model for classification and fast-path orchestration decisions.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4.1-nano',
    fastDefaultProvider: 'openai',
    fastDefaultModelId: 'gpt-4.1-nano',
  },
  {
    key: 'langgraph.planner',
    engine: 'langgraph',
    kind: 'planner',
    label: 'LangGraph Planner',
    description: 'Intermediate LangGraph planner for step decomposition and multi-agent task design.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4.1-mini',
    fastDefaultProvider: 'openai',
    fastDefaultModelId: 'gpt-4.1-nano',
  },
  {
    key: 'langgraph.synthesis',
    engine: 'langgraph',
    kind: 'synthesis',
    label: 'LangGraph Synthesis',
    description: 'Final LangGraph response composition model used after agent outputs are gathered.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4.1-mini',
    fastDefaultProvider: 'openai',
    fastDefaultModelId: 'gpt-4.1-mini',
  },
];

export const AI_CONTROL_TARGET_MAP = new Map(
  AI_CONTROL_TARGETS.map((target) => [target.key, target] as const),
);

export const isAiThinkingLevel = (value: string): value is AiThinkingLevel =>
  AI_THINKING_LEVELS.includes(value as AiThinkingLevel);
