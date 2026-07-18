import { isAbsolute, join, relative } from 'node:path';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Logger } from '../../shared/logger';
import type {
  ManagerTeachEvidenceManifest,
  ManagerTeachFrameOcr,
  ManagerTeachMediaExtractor,
  ManagerTeachTranscript,
  ManagerTeachTranscriber,
} from './manager-teach-media.types';
import type { ImageOcrResult } from '../ingestion/text-extraction/image-ocr.extractor';

export interface ManagerTeachMediaProcessorDeps {
  readonly extractor: ManagerTeachMediaExtractor;
  readonly ocr: ManagerTeachFrameOcr;
  readonly transcriber: ManagerTeachTranscriber;
  readonly logger: Logger;
  readonly ocrConcurrency: number;
  readonly transcriptionModel: string;
}

export interface ManagerTeachMediaProcessInput {
  readonly teachSessionId: string;
  readonly companyId: string;
  readonly departmentId: string;
  readonly managerId: string;
  readonly source: 'recording' | 'upload';
  readonly originalFileName: string | null;
  readonly videoPath: string;
  readonly evidenceDir: string;
  readonly assertActive: () => Promise<void>;
  readonly onProgress: (progress: number) => Promise<void>;
}

export interface ManagerTeachMediaProcessResult {
  readonly manifestPath: string;
  readonly sizeBytes: number;
  readonly frameCount: number;
  readonly warningCount: number;
}

export class ManagerTeachMediaProcessor {
  private readonly log: Logger;

  constructor(private readonly deps: ManagerTeachMediaProcessorDeps) {
    this.log = deps.logger.child({ service: 'manager-teach-media' });
  }

  async process(input: ManagerTeachMediaProcessInput): Promise<ManagerTeachMediaProcessResult> {
    await rm(input.evidenceDir, { recursive: true, force: true });
    await mkdir(input.evidenceDir, { recursive: true });

    try {
      await input.onProgress(35);
      const media = await this.deps.extractor.extract({
        videoPath: input.videoPath,
        outputDir: input.evidenceDir,
      });
      if (media.frames.length === 0) throw new Error('Teach recording produced no usable frames');
      await input.assertActive();
      await input.onProgress(55);

      const warnings: string[] = [];
      const transcript = await this.createTranscript(media, input.evidenceDir, warnings);
      await input.assertActive();
      await input.onProgress(70);

      const frames = await this.ocrFrames(media.frames, input.evidenceDir, input, warnings);
      await input.assertActive();

      const manifest: ManagerTeachEvidenceManifest = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        source: {
          teachSessionId: input.teachSessionId,
          companyId: input.companyId,
          departmentId: input.departmentId,
          managerId: input.managerId,
          kind: input.source,
          originalFileName: input.originalFileName,
        },
        video: media.video,
        extraction: media.extraction,
        frames,
        transcript,
        warnings,
      };

      const manifestPath = join(input.evidenceDir, 'evidence-manifest.json');
      const temporaryPath = `${manifestPath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, manifestPath);
      const metadata = await stat(manifestPath);
      await input.onProgress(95);
      this.log.info('manager-teach.evidence.ready', {
        teachSessionId: input.teachSessionId,
        frames: frames.length,
        transcriptSegments: transcript.segments.length,
        warnings: warnings.length,
      });
      return {
        manifestPath,
        sizeBytes: metadata.size,
        frameCount: frames.length,
        warningCount: warnings.length,
      };
    } catch (error) {
      await rm(input.evidenceDir, { recursive: true, force: true });
      throw error;
    }
  }

  private async createTranscript(
    media: Awaited<ReturnType<ManagerTeachMediaExtractor['extract']>>,
    evidenceDir: string,
    warnings: string[],
  ): Promise<ManagerTeachTranscript> {
    if (!media.audio?.path || media.audio.skippedReason) {
      const warning = media.audio?.skippedReason
        ? `Audio was unavailable: ${media.audio.skippedReason}`
        : 'The recording did not contain an audio track.';
      warnings.push(warning);
      return {
        provider: 'openai',
        model: this.deps.transcriptionModel,
        timing: 'chunk',
        durationSeconds: media.video.durationSeconds,
        segments: [],
        text: '',
        warnings: [warning],
      };
    }
    return this.deps.transcriber.transcribe({
      audioPath: media.audio.path,
      ffmpegPath: media.extraction.ffmpegPath,
      durationSeconds: media.audio.durationSeconds || media.video.durationSeconds,
      workDir: join(evidenceDir, '.audio-chunks'),
    });
  }

  private async ocrFrames(
    mediaFrames: Awaited<ReturnType<ManagerTeachMediaExtractor['extract']>>['frames'],
    evidenceDir: string,
    input: ManagerTeachMediaProcessInput,
    warnings: string[],
  ): Promise<ManagerTeachEvidenceManifest['frames']> {
    const results: Array<ManagerTeachEvidenceManifest['frames'][number] | undefined> =
      new Array(mediaFrames.length);
    let failures = 0;
    const concurrency = Math.max(1, Math.min(this.deps.ocrConcurrency, mediaFrames.length));
    let cursor = 0;
    let completed = 0;

    const worker = async () => {
      while (cursor < mediaFrames.length) {
        const index = cursor++;
        const frame = mediaFrames[index];
        if (!frame) continue;
        const safePath = toEvidenceRelativePath(evidenceDir, frame.path);
        let ocr: ImageOcrResult;
        try {
          ocr = await this.deps.ocr.extract(frame.path);
        } catch (error) {
          failures += 1;
          const warning = `OCR failed for frame ${index + 1}: ${safeErrorMessage(error)}`;
          warnings.push(warning);
          ocr = {
            ocrText: '',
            caption: '',
            uiElements: [],
            confidence: 0,
            warnings: [warning],
            provider: 'openrouter',
            model: 'unavailable',
          };
        }
        results[index] = { sequence: index + 1, path: safePath, bytes: frame.bytes, ocr };
        completed += 1;
        await input.onProgress(70 + Math.floor((completed / mediaFrames.length) * 22));
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    if (failures === mediaFrames.length) {
      throw new Error('OCR failed for every extracted frame');
    }
    return results.filter((frame): frame is NonNullable<typeof frame> => frame !== undefined);
  }
}

function toEvidenceRelativePath(evidenceDir: string, filePath: string): string {
  const path = relative(evidenceDir, filePath);
  if (!path || path.startsWith('..') || isAbsolute(path)) {
    throw new Error('Peepshow returned a frame outside the Teach evidence directory');
  }
  return path;
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
}
