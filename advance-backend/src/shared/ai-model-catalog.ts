export type AiModelProvider = 'google' | 'openai';

export interface AiModelEntry {
  provider:           AiModelProvider;
  modelId:            string;
  label:              string;
  description:        string;
  preview?:           boolean;
  supportsThinking?:  boolean;
  speed:              'fast' | 'medium' | 'slow';
  cost:               'low' | 'medium' | 'high';
  maxContextTokens:   number;
  outputReserveTokens: number;
}

export const AI_MODEL_CATALOG: AiModelEntry[] = [
  // ── Google ────────────────────────────────────────────────────────────────
  {
    provider:            'google',
    modelId:             'gemini-2.5-pro-preview-05-06',
    label:               'Gemini 2.5 Pro',
    description:         'Most capable Gemini model with deep reasoning and long context.',
    preview:             true,
    supportsThinking:    true,
    speed:               'slow',
    cost:                'high',
    maxContextTokens:    1_000_000,
    outputReserveTokens: 8_192,
  },
  {
    provider:            'google',
    modelId:             'gemini-2.0-flash',
    label:               'Gemini 2.0 Flash',
    description:         'Fast, efficient Gemini model for high-volume tasks.',
    speed:               'fast',
    cost:                'low',
    maxContextTokens:    1_000_000,
    outputReserveTokens: 8_192,
  },
  {
    provider:            'google',
    modelId:             'gemini-2.0-flash-thinking-exp',
    label:               'Gemini 2.0 Flash Thinking',
    description:         'Flash model with experimental chain-of-thought reasoning.',
    preview:             true,
    supportsThinking:    true,
    speed:               'medium',
    cost:                'low',
    maxContextTokens:    1_000_000,
    outputReserveTokens: 8_192,
  },
  {
    provider:            'google',
    modelId:             'gemini-1.5-pro',
    label:               'Gemini 1.5 Pro',
    description:         'Balanced Gemini model for complex multi-step tasks.',
    speed:               'medium',
    cost:                'medium',
    maxContextTokens:    1_000_000,
    outputReserveTokens: 8_192,
  },
  {
    provider:            'google',
    modelId:             'gemini-1.5-flash',
    label:               'Gemini 1.5 Flash',
    description:         'Cost-effective Gemini model for fast, routine tasks.',
    speed:               'fast',
    cost:                'low',
    maxContextTokens:    1_000_000,
    outputReserveTokens: 8_192,
  },
  // ── OpenAI ────────────────────────────────────────────────────────────────
  {
    provider:            'openai',
    modelId:             'gpt-4o',
    label:               'GPT-4o',
    description:         "OpenAI's flagship multimodal model.",
    speed:               'medium',
    cost:                'high',
    maxContextTokens:    128_000,
    outputReserveTokens: 4_096,
  },
  {
    provider:            'openai',
    modelId:             'gpt-4o-mini',
    label:               'GPT-4o Mini',
    description:         'Lightweight, cost-efficient GPT-4o variant.',
    speed:               'fast',
    cost:                'low',
    maxContextTokens:    128_000,
    outputReserveTokens: 4_096,
  },
  {
    provider:            'openai',
    modelId:             'gpt-4-turbo',
    label:               'GPT-4 Turbo',
    description:         'High-capability GPT-4 with large context window.',
    speed:               'medium',
    cost:                'high',
    maxContextTokens:    128_000,
    outputReserveTokens: 4_096,
  },
];
