import type { KnowledgeImageOcr } from './default-knowledge-document.parser';
import { extractImageTextWithVision } from '../ai/vision/openrouter-vision';

export class OpenRouterKnowledgeOcr implements KnowledgeImageOcr {
  constructor(private readonly options: {
    readonly apiKey: string;
    readonly model: string;
    readonly providerOrder?: string;
  }) {}

  async extract(input: {
    image: Buffer;
    mimeType: string;
    signal: AbortSignal;
  }) {
    const result = await extractImageTextWithVision(input.image, input.mimeType, {
      ...this.options,
      signal: input.signal,
    });
    return {
      text: result.ocrText,
      caption: result.caption,
      confidence: result.confidence,
      warnings: result.warnings,
    };
  }
}
