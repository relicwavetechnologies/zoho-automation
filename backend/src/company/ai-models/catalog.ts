export type AiModelProvider = 'google' | 'openai';
export type AiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export type AiControlEngine = 'mastra' | 'langgraph';
export type AiControlTargetKind = 'supervisor' | 'specialist' | 'router' | 'planner' | 'synthesis';

export const AI_THINKING_LEVELS: AiThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];

export type AiControlTargetKey =
  | 'mastra.supervisor'
  | 'mastra.zoho-specialist'
  | 'mastra.search'
  | 'mastra.outreach'
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
  },
  {
    provider: 'google',
    modelId: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    description: 'Balanced stable Gemini model with stronger quality than Flash-Lite.',
    supportsThinking: true,
    speed: 'balanced',
    cost: 'balanced',
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
  },
  {
    provider: 'openai',
    modelId: 'gpt-4.1-nano',
    label: 'GPT-4.1 Nano',
    description: 'Cheapest GPT-4.1 variant for classification, routing, and short tool outputs.',
    speed: 'fast',
    cost: 'cheap',
  },
  {
    provider: 'openai',
    modelId: 'gpt-4.1-mini',
    label: 'GPT-4.1 Mini',
    description: 'Best OpenAI balance for tool calling, synthesis, and agent orchestration.',
    speed: 'balanced',
    cost: 'balanced',
  },
  {
    provider: 'openai',
    modelId: 'gpt-4.1',
    label: 'GPT-4.1',
    description: 'Highest-quality OpenAI option in this control plane, with higher cost/latency.',
    speed: 'strong',
    cost: 'premium',
  },
];

export const AI_MODEL_CATALOG_MAP = new Map(
  AI_MODEL_CATALOG.map((entry) => [`${entry.provider}:${entry.modelId}`, entry] as const),
);

export const AI_CONTROL_TARGETS: AiControlTargetDefinition[] = [
  {
    key: 'mastra.supervisor',
    engine: 'mastra',
    kind: 'supervisor',
    label: 'Mastra Supervisor',
    description: 'Top-level Mastra orchestrator that routes across Zoho, outreach, and web search specialists.',
    defaultProvider: 'google',
    defaultModelId: 'gemini-3-flash-preview',
    defaultThinkingLevel: 'high',
  },
  {
    key: 'mastra.zoho-specialist',
    engine: 'mastra',
    kind: 'specialist',
    label: 'Mastra Zoho Specialist',
    description: 'CRM specialist for live Zoho reads and recovery fallback synthesis.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4.1-mini',
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
  },
  {
    key: 'mastra.outreach',
    engine: 'mastra',
    kind: 'specialist',
    label: 'Mastra Outreach Specialist',
    description: 'SEO/outreach inventory filtering specialist for publisher discovery and ranking.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4.1-nano',
  },
  {
    key: 'mastra.synthesis',
    engine: 'mastra',
    kind: 'synthesis',
    label: 'Mastra Synthesis',
    description: 'Response-polishing agent used to turn grounded records into concise business answers.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4.1-mini',
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
  },
  {
    key: 'langgraph.router',
    engine: 'langgraph',
    kind: 'router',
    label: 'LangGraph Router',
    description: 'Low-latency intent/router model for classification and fast-path orchestration decisions.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4.1-nano',
  },
  {
    key: 'langgraph.planner',
    engine: 'langgraph',
    kind: 'planner',
    label: 'LangGraph Planner',
    description: 'Intermediate LangGraph planner for step decomposition and multi-agent task design.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4.1-mini',
  },
  {
    key: 'langgraph.synthesis',
    engine: 'langgraph',
    kind: 'synthesis',
    label: 'LangGraph Synthesis',
    description: 'Final LangGraph response composition model used after agent outputs are gathered.',
    defaultProvider: 'openai',
    defaultModelId: 'gpt-4.1-mini',
  },
];

export const AI_CONTROL_TARGET_MAP = new Map(
  AI_CONTROL_TARGETS.map((target) => [target.key, target] as const),
);

export const isAiThinkingLevel = (value: string): value is AiThinkingLevel =>
  AI_THINKING_LEVELS.includes(value as AiThinkingLevel);
