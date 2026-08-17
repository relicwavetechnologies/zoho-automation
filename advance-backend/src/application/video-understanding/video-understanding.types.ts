/**
 * What Divo understood from a video, and the three things it needed to get it.
 *
 * These types used to live under `persona-learning` and be named after Teach,
 * which was true of the only caller rather than of the work: nothing in reading
 * a recording knows what the reading is *for*. A video attached to an ordinary
 * chat needs exactly this and none of the session bookkeeping that came with it.
 *
 * The frame reading is declared here rather than imported from the OpenRouter
 * adapter. An application module naming an infrastructure type is backwards —
 * it makes the vision provider part of the interface every caller has to learn,
 * and it means swapping the provider edits the meaning of "a frame we read".
 * The adapter satisfies this shape; it does not define it.
 */

/** One still taken out of the video, before anything has read it. */
export interface ExtractedFrame {
  readonly path: string;
  readonly bytes: number;
}

export interface ExtractedAudio {
  readonly path: string | null;
  readonly codec: string | null;
  readonly channels: number | null;
  readonly sampleRateHz: number | null;
  readonly durationSeconds: number;
  readonly sizeBytes: number;
  /** Why there is nothing to transcribe, when there is nothing to transcribe. */
  readonly skippedReason: string | null;
}

export interface VideoFacts {
  readonly durationSeconds: number;
  readonly container: string | null;
  readonly codec: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  readonly sizeBytes: number | null;
}

/**
 * How the stills were chosen.
 *
 * Kept in the understanding because it is the honest record of what was looked
 * at: forty frames pruned from four hundred is a different reading of a video
 * than forty frames that were all there was.
 */
export interface ExtractionFacts {
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
}

export interface VideoExtraction {
  readonly outputDir: string;
  readonly strategy: 'scene' | 'fps' | 'transnet';
  readonly frames: readonly ExtractedFrame[];
  readonly video: VideoFacts;
  readonly extraction: ExtractionFacts;
  readonly audio: ExtractedAudio | null;
}

export interface VideoFrameExtractor {
  extract(input: { videoPath: string; outputDir: string }): Promise<VideoExtraction>;
}

export interface TranscriptSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface VideoTranscript {
  readonly provider: 'openai';
  readonly model: string;
  /**
   * `chunk` means a segment's start and end come from the chunk it was
   * transcribed in, not from word timings the model returned. Stated in the
   * value so nothing downstream reads a five-minute boundary as a precise
   * timestamp.
   */
  readonly timing: 'chunk';
  readonly durationSeconds: number;
  readonly segments: readonly TranscriptSegment[];
  readonly text: string;
  readonly warnings: readonly string[];
}

export interface VideoTranscriber {
  transcribe(input: {
    audioPath: string;
    ffmpegPath: string;
    durationSeconds: number;
    workDir: string;
  }): Promise<VideoTranscript>;
}

/** What a vision model saw in one still. */
export interface FrameReading {
  readonly ocrText: string;
  readonly caption: string;
  readonly uiElements: readonly string[];
  readonly confidence: number;
  readonly warnings: readonly string[];
  readonly provider: string;
  readonly model: string;
}

export interface FrameReader {
  read(framePath: string): Promise<FrameReading>;
}

export interface UnderstoodFrame {
  /** 1-based, in the order the frames were taken. */
  readonly sequence: number;
  /** Relative to the work directory, never absolute — see the service. */
  readonly path: string;
  readonly bytes: number;
  readonly reading: FrameReading;
}

/**
 * Everything Divo understood from one video.
 *
 * Deliberately says nothing about who uploaded it, which conversation it
 * belongs to, or what it will be used for. Callers that need to record those
 * things wrap this value; they do not ask the understanding to carry them.
 */
export interface VideoUnderstanding {
  readonly video: VideoFacts;
  readonly extraction: ExtractionFacts;
  readonly frames: readonly UnderstoodFrame[];
  readonly transcript: VideoTranscript;
  /** Everything that went wrong without being fatal, in the reader's words. */
  readonly warnings: readonly string[];
}
