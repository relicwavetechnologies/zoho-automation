import { readFile } from 'node:fs/promises';
import type { ManagerTeachFrameOcr } from '../../../application/persona-learning/manager-teach-media.types';
import {
  extractImageTextWithVision,
  type VisionOcrResult,
} from '../vision/openrouter-vision';

export class OpenRouterManagerTeachFrameOcr implements ManagerTeachFrameOcr {
  constructor(private readonly options: { apiKey: string; model: string }) {}

  async extract(framePath: string): Promise<VisionOcrResult> {
    return extractImageTextWithVision(await readFile(framePath), 'image/jpeg', {
      apiKey: this.options.apiKey,
      model: this.options.model,
    });
  }
}
