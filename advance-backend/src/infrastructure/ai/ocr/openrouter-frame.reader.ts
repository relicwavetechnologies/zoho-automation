import { readFile } from 'node:fs/promises';
import type { FrameReader, FrameReading } from '../../../application/video-understanding/video-understanding.types';
import { extractImageTextWithVision } from '../vision/openrouter-vision';

/** Reads one video still with the shared vision model. */
export class OpenRouterFrameReader implements FrameReader {
  constructor(private readonly options: { apiKey: string; model: string }) {}

  async read(framePath: string): Promise<FrameReading> {
    return extractImageTextWithVision(await readFile(framePath), 'image/jpeg', {
      apiKey: this.options.apiKey,
      model: this.options.model,
    });
  }
}
