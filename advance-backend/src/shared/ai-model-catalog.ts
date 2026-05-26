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
    modelId:             'gemini-3.1-flash-lite',
    label:               'Gemini 3.1 Flash Lite',
    description:         'GA fast model for OCR, routing, and high-volume tasks.',
    speed:               'fast',
    cost:                'low',
    maxContextTokens:    1_000_000,
    outputReserveTokens: 8_192,
  },
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
  // ── OpenAI Codex Gateway ──────────────────────────────────────────────────
  {
    provider:            'openai',
    modelId:             'gpt-5.5',
    label:               'GPT-5.5',
    description:         'Frontier Codex model for the most complex coding, research, and real-world work.',
    supportsThinking:    true,
    speed:               'slow',
    cost:                'high',
    maxContextTokens:    400_000,
    outputReserveTokens: 32_000,
  },
  {
    provider:            'openai',
    modelId:             'gpt-5.4',
    label:               'GPT-5.4',
    description:         'Strong Codex model for everyday coding and production agent work.',
    supportsThinking:    true,
    speed:               'medium',
    cost:                'high',
    maxContextTokens:    400_000,
    outputReserveTokens: 32_000,
  },
  {
    provider:            'openai',
    modelId:             'gpt-5.4-mini',
    label:               'GPT-5.4 Mini',
    description:         'Fast, cost-efficient Codex model for lighter coding and routing tasks.',
    supportsThinking:    true,
    speed:               'fast',
    cost:                'low',
    maxContextTokens:    400_000,
    outputReserveTokens: 32_000,
  },
  {
    provider:            'openai',
    modelId:             'gpt-5.3-codex',
    label:               'GPT-5.3 Codex',
    description:         'Coding-optimized Codex model for agent execution and implementation tasks.',
    supportsThinking:    true,
    speed:               'medium',
    cost:                'medium',
    maxContextTokens:    400_000,
    outputReserveTokens: 32_000,
  },
];
