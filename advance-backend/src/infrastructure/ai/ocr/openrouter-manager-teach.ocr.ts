import { readFile } from 'node:fs/promises';
import type { ManagerTeachFrameOcr } from '../../../application/persona-learning/manager-teach-media.types';
import {
  extractImageTextWithProvider,
  type ImageOcrResult,
} from '../../../application/ingestion/text-extraction/image-ocr.extractor';

export class OpenRouterManagerTeachFrameOcr implements ManagerTeachFrameOcr {
  constructor(private readonly options: { apiKey: string; model: string }) {}

  async extract(framePath: string): Promise<ImageOcrResult> {
    const bytes = await readFile(framePath);
    return extractImageTextWithProvider(bytes, 'image/jpeg', {
      provider: 'openrouter',
      openrouterApiKey: this.options.apiKey,
      visionModel: this.options.model,
    });
  }
}
