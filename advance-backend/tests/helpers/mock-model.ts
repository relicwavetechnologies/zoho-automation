import type { LanguageModel } from 'ai';

export interface MockToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

/** Build a mock LanguageModel that returns a fixed text response. */
export function textModel(text: string): LanguageModel {
  return {
    provider: 'mock',
    modelId: 'mock-text',
    specificationVersion: 'v2',
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }],
      finishReason: 'stop' as const,
      usage: { inputTokens: 10, outputTokens: 5 },
      rawCall: { rawPrompt: null, rawSettings: {} },
      rawResponse: { headers: {} },
    }),
    doStream: async () => { throw new Error('streaming not supported in mock'); },
  } as unknown as LanguageModel;
}

/** Build a mock LanguageModel that returns specific tool calls. */
export function toolCallModel(calls: MockToolCall[]): LanguageModel {
  return {
    provider: 'mock',
    modelId: 'mock-tool-call',
    specificationVersion: 'v2',
    doGenerate: async () => ({
      content: calls.map((c, i) => ({
        type: 'tool-call' as const,
        toolCallId: `tc${i}`,
        toolName: c.toolName,
        input: c.input,
      })),
      finishReason: 'tool-calls' as const,
      usage: { inputTokens: 10, outputTokens: 20 },
      rawCall: { rawPrompt: null, rawSettings: {} },
      rawResponse: { headers: {} },
    }),
    doStream: async () => { throw new Error('streaming not supported in mock'); },
  } as unknown as LanguageModel;
}

/** Build a mock LanguageModel that throws on generate. */
export function errorModel(message = 'LLM unavailable'): LanguageModel {
  return {
    provider: 'mock',
    modelId: 'mock-error',
    specificationVersion: 'v2',
    doGenerate: async () => { throw new Error(message); },
    doStream: async () => { throw new Error(message); },
  } as unknown as LanguageModel;
}
