import { z } from 'zod';

const SynthesisSchema = z.object({
  text: z.string().min(1),
  taskStatus: z.enum(['done', 'failed', 'cancelled']).default('done'),
});

export type ResolvedSynthesisContract = {
  source: 'model' | 'deterministic_fallback';
  validationErrors: string[];
  synthesis: z.infer<typeof SynthesisSchema>;
};

const parseRawOutput = (rawLlmOutput: string | Record<string, unknown> | null | undefined): Record<string, unknown> | null => {
  if (!rawLlmOutput) {
    return null;
  }
  if (typeof rawLlmOutput === 'object') {
    return rawLlmOutput;
  }
  try {
    return JSON.parse(rawLlmOutput) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const resolveSynthesisContract = (input: {
  rawLlmOutput: string | Record<string, unknown> | null | undefined;
  deterministicFallback: {
    text: string;
    taskStatus: 'done' | 'failed' | 'cancelled';
  };
}): ResolvedSynthesisContract => {
  const parsedRaw = parseRawOutput(input.rawLlmOutput);
  if (!parsedRaw) {
    return {
      source: 'deterministic_fallback',
      validationErrors: [input.rawLlmOutput ? 'Synthesis JSON could not be parsed.' : 'Synthesis returned no output.'],
      synthesis: input.deterministicFallback,
    };
  }

  const parsed = SynthesisSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    return {
      source: 'deterministic_fallback',
      validationErrors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`),
      synthesis: input.deterministicFallback,
    };
  }

  if (!parsed.data.text.trim()) {
    return {
      source: 'deterministic_fallback',
      validationErrors: ['text: String must contain at least 1 character(s)'],
      synthesis: input.deterministicFallback,
    };
  }

  return {
    source: 'model',
    validationErrors: [],
    synthesis: {
      text: parsed.data.text.trim(),
      taskStatus: parsed.data.taskStatus,
    },
  };
};
