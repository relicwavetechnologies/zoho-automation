import { z } from 'zod';

const responseSchema = z.object({
  text: z.string(),
  language_code: z.string().optional(),
  language_probability: z.number().optional(),
});

export interface ElevenLabsTranscriptionInput {
  readonly audio: Buffer;
  readonly fileName: string;
  readonly mimeType: string;
  readonly abortSignal?: AbortSignal;
}

export interface ElevenLabsTranscriptionResult {
  readonly text: string;
  readonly languageCode?: string;
  readonly languageProbability?: number;
}

export class ElevenLabsTranscriptionClient {
  constructor(private readonly options: {
    apiKey: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    if (!options.apiKey.trim()) throw new Error('ElevenLabs transcription is not configured');
  }

  async transcribe(input: ElevenLabsTranscriptionInput): Promise<ElevenLabsTranscriptionResult> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(input.audio)], { type: input.mimeType }),
      input.fileName,
    );
    form.append('model_id', 'scribe_v2');

    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs ?? 120_000);
    const signal = input.abortSignal
      ? AbortSignal.any([input.abortSignal, timeoutSignal])
      : timeoutSignal;
    const response = await (this.options.fetchImpl ?? fetch)(
      'https://api.elevenlabs.io/v1/speech-to-text',
      {
        method: 'POST',
        headers: { 'xi-api-key': this.options.apiKey.trim() },
        body: form,
        signal,
      },
    );

    if (!response.ok) {
      throw new Error(`ElevenLabs transcription failed (${response.status})`);
    }

    const parsed = responseSchema.parse(await response.json());
    return {
      text: parsed.text.trim(),
      ...(parsed.language_code ? { languageCode: parsed.language_code } : {}),
      ...(parsed.language_probability !== undefined
        ? { languageProbability: parsed.language_probability }
        : {}),
    };
  }
}
