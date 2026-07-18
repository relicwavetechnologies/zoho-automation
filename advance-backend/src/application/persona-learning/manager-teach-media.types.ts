import type { ImageOcrResult } from '../ingestion/text-extraction/image-ocr.extractor';

export interface ManagerTeachExtractedFrame {
  readonly path: string;
  readonly bytes: number;
}

export interface ManagerTeachExtractedAudio {
  readonly path: string | null;
  readonly codec: string | null;
  readonly channels: number | null;
  readonly sampleRateHz: number | null;
  readonly durationSeconds: number;
  readonly sizeBytes: number;
  readonly skippedReason: string | null;
}

export interface ManagerTeachMediaExtraction {
  readonly outputDir: string;
  readonly strategy: 'scene' | 'fps' | 'transnet';
  readonly frames: readonly ManagerTeachExtractedFrame[];
  readonly video: {
    readonly durationSeconds: number;
    readonly container: string | null;
    readonly codec: string | null;
    readonly width: number | null;
    readonly height: number | null;
    readonly fps: number | null;
    readonly sizeBytes: number | null;
  };
  readonly extraction: {
    readonly strategy: string;
    readonly threshold: number | null;
    readonly framesEmitted: number;
    readonly framesBeforePrune: number;
    readonly framesPruned: number;
    readonly framesDeduped: number;
    readonly dedupDistance: number | null;
    readonly motionSignalLevel: string | null;
    readonly elapsedMs: number | null;
    readonly ffmpegPath: string;
  };
  readonly audio: ManagerTeachExtractedAudio | null;
}

export interface ManagerTeachMediaExtractor {
  extract(input: { videoPath: string; outputDir: string }): Promise<ManagerTeachMediaExtraction>;
}

export interface ManagerTeachTranscriptSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface ManagerTeachTranscript {
  readonly provider: 'openai';
  readonly model: string;
  readonly timing: 'chunk';
  readonly durationSeconds: number;
  readonly segments: readonly ManagerTeachTranscriptSegment[];
  readonly text: string;
  readonly warnings: readonly string[];
}

export interface ManagerTeachTranscriber {
  transcribe(input: {
    audioPath: string;
    ffmpegPath: string;
    durationSeconds: number;
    workDir: string;
  }): Promise<ManagerTeachTranscript>;
}

export interface ManagerTeachFrameOcr {
  extract(framePath: string): Promise<ImageOcrResult>;
}

export interface ManagerTeachEvidenceManifest {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly source: {
    readonly teachSessionId: string;
    readonly companyId: string;
    readonly departmentId: string;
    readonly managerId: string;
    readonly kind: 'recording' | 'upload';
    readonly originalFileName: string | null;
  };
  readonly video: ManagerTeachMediaExtraction['video'];
  readonly extraction: ManagerTeachMediaExtraction['extraction'];
  readonly frames: readonly {
    readonly sequence: number;
    readonly path: string;
    readonly bytes: number;
    readonly ocr: ImageOcrResult;
  }[];
  readonly transcript: ManagerTeachTranscript;
  readonly warnings: readonly string[];
}
