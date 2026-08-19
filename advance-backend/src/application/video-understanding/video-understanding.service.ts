/**
 * Read a video: take stills, hear the words, and say what was on screen.
 *
 * The whole of it sits behind `understand(videoPath, workDir)`. That is the
 * point of this module — ffmpeg scene detection, chunked transcription and a
 * concurrent OCR fan-out with partial-failure handling are a lot of behaviour,
 * and a caller should have to learn two paths and nothing else to get it.
 *
 * The previous interface took ten fields, seven of which were the caller's own
 * bookkeeping — a session id, a company, a department, a manager, whether the
 * file was recorded or uploaded — copied straight through into the output. None
 * of it changed how a single frame was read. Carrying it here meant the second
 * caller either had to invent a session it did not have, or the module had to
 * grow a second shape. Understanding a video needs bytes and somewhere to put
 * the stills.
 */

import { isAbsolute, join, relative } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import type { Logger } from '../../shared/logger';
import { redactLikelySecrets } from '../gateway/redact-secrets';
import type {
  FrameReader,
  FrameReading,
  UnderstoodFrame,
  VideoExtraction,
  VideoFrameExtractor,
  VideoTranscriber,
  VideoTranscript,
  VideoUnderstanding,
} from './video-understanding.types';

export interface VideoUnderstandingDeps {
  readonly extractor: VideoFrameExtractor;
  readonly reader: FrameReader;
  readonly transcriber: VideoTranscriber;
  readonly logger: Logger;
  readonly readConcurrency: number;
  /** Named in the transcript even when there was no audio to send it. */
  readonly transcriptionModel: string;
}

export interface UnderstandVideoInput {
  readonly videoPath: string;
  /**
   * Where the stills live. Emptied first and removed if the reading fails, so a
   * retry never reads half of a previous attempt's frames.
   */
  readonly workDir: string;
  /**
   * Called between stages so a caller that can cancel gets the chance to. Throw
   * to stop the reading; the work directory is cleaned up on the way out.
   */
  readonly assertActive?: () => Promise<void>;
  /**
   * How far through *this reading* we are, 0–100.
   *
   * Its own scale rather than the caller's. These numbers used to be a slice of
   * one Teach session's progress bar — a fresh video reported 35% before a
   * single frame had been read, because 35 was where reading started in
   * somebody else's pipeline. A caller with its own bar maps this into it.
   */
  readonly onProgress?: (percent: number) => Promise<void>;
}

/* Reading is the long pole and the only stage with a natural fraction, so it
   gets the bulk of the scale; the two before it report at their own completion
   rather than pretending to be smooth. */
const FRAMES_TAKEN = 20;
const TRANSCRIPT_DONE = 45;
const READING_SPAN = 55;

export class VideoUnderstandingService {
  private readonly log: Logger;

  constructor(private readonly deps: VideoUnderstandingDeps) {
    this.log = deps.logger.child({ service: 'video-understanding' });
  }

  async understand(input: UnderstandVideoInput): Promise<VideoUnderstanding> {
    await rm(input.workDir, { recursive: true, force: true });
    await mkdir(input.workDir, { recursive: true });

    try {
      const extracted = await this.deps.extractor.extract({
        videoPath: input.videoPath,
        outputDir: input.workDir,
      });
      // A video nothing could be taken from is not a quiet result, it is a
      // failed reading — answering from an empty manifest would be answering
      // from the filename.
      if (extracted.frames.length === 0) throw new Error('The video produced no usable frames');
      await input.assertActive?.();
      await input.onProgress?.(FRAMES_TAKEN);

      const warnings: string[] = [];
      const transcript = await this.transcribe(extracted, input.workDir, warnings);
      await input.assertActive?.();
      await input.onProgress?.(TRANSCRIPT_DONE);

      const frames = await this.readFrames(extracted.frames, input, warnings);
      await input.assertActive?.();

      this.log.info('video.understood', {
        frames: frames.length,
        transcriptSegments: transcript.segments.length,
        warnings: warnings.length,
      });

      return {
        video: extracted.video,
        extraction: extracted.extraction,
        frames,
        transcript,
        warnings,
      };
    } catch (error) {
      await rm(input.workDir, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * The words, or an honest account of why there are none.
   *
   * Three ways there can be no narration, and all three end the same way: an
   * empty transcript, a warning carried all the way out, and a reading that
   * still happened. "The video said nothing", "there was no audio track" and
   * "Divo could not hear it" are different facts and none of them is a reason
   * to throw away thirteen screens that read perfectly well.
   *
   * The last of those used to be fatal while the first two were not, which is
   * how an expired provider key came back to a member as "this recording can't
   * be opened" — a claim about their file, made about our billing. A caller
   * that genuinely needs narration can see it is missing: the transcript is
   * empty and the warning says why.
   */
  private async transcribe(
    extracted: VideoExtraction,
    workDir: string,
    warnings: string[],
  ): Promise<VideoTranscript> {
    if (!extracted.audio?.path || extracted.audio.skippedReason) {
      return this.noWords(extracted, warnings, 'silent', extracted.audio?.skippedReason
        ? `Audio was unavailable: ${extracted.audio.skippedReason}`
        : 'The recording did not contain an audio track.');
    }
    try {
      return await this.deps.transcriber.transcribe({
        audioPath: extracted.audio.path,
        ffmpegPath: extracted.extraction.ffmpegPath,
        durationSeconds: extracted.audio.durationSeconds || extracted.video.durationSeconds,
        workDir: join(workDir, '.audio-chunks'),
      });
    } catch (error) {
      this.log.warn('video.transcription_failed', { error: safeErrorMessage(error) });
      return this.noWords(
        extracted,
        warnings,
        'unheard',
        `The speech in this recording could not be transcribed: ${safeErrorMessage(error)}`,
      );
    }
  }

  private noWords(
    extracted: VideoExtraction,
    warnings: string[],
    emptyBecause: 'silent' | 'unheard',
    warning: string,
  ): VideoTranscript {
    warnings.push(warning);
    return {
      provider: 'openai',
      model: this.deps.transcriptionModel,
      timing: 'chunk',
      durationSeconds: extracted.video.durationSeconds,
      segments: [],
      text: '',
      warnings: [warning],
      emptyBecause,
    };
  }

  /**
   * Every still, read concurrently, in order.
   *
   * One frame failing is survivable — the reader records the failure in place
   * and the rest of the video still reads. Every frame failing is not: that is
   * a broken vision provider wearing the costume of a video with nothing in it.
   */
  private async readFrames(
    extracted: readonly { path: string; bytes: number }[],
    input: UnderstandVideoInput,
    warnings: string[],
  ): Promise<UnderstoodFrame[]> {
    const results: Array<UnderstoodFrame | undefined> = new Array(extracted.length);
    let failures = 0;
    let cursor = 0;
    let completed = 0;
    const concurrency = Math.max(1, Math.min(this.deps.readConcurrency, extracted.length));

    const worker = async () => {
      while (cursor < extracted.length) {
        const index = cursor++;
        const frame = extracted[index];
        if (!frame) continue;
        const path = this.relativeFramePath(input.workDir, frame.path);
        let reading: FrameReading;
        try {
          /* Redacted here, at the one place a frame becomes text, rather than
             at each of the places that text is later used. A screen recording
             of a terminal or a dev-tools panel routinely contains a live key,
             and everything downstream — the prompt, the stored reading — would
             otherwise carry it. The same rule the pasted-image path uses. */
          reading = redactReading(await this.deps.reader.read(frame.path));
        } catch (error) {
          failures += 1;
          const warning = `Reading frame ${index + 1} failed: ${safeErrorMessage(error)}`;
          warnings.push(warning);
          reading = {
            ocrText: '', caption: '', uiElements: [], confidence: 0,
            warnings: [warning], provider: 'unavailable', model: 'unavailable',
          };
        }
        results[index] = { sequence: index + 1, path, bytes: frame.bytes, reading };
        completed += 1;
        await input.onProgress?.(
          TRANSCRIPT_DONE + Math.floor((completed / extracted.length) * READING_SPAN),
        );
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    if (failures === extracted.length) throw new Error('Reading failed for every extracted frame');
    return results.filter((frame): frame is UnderstoodFrame => frame !== undefined);
  }

  /**
   * Frames are named relative to the work directory, and proven to be inside it.
   *
   * Absolute paths would put the server's filesystem layout into a value that
   * gets stored, moved between machines and shown to a model. The escape check
   * is not paranoia about our own extractor: the understanding is written from
   * whatever it returns, and a path outside the directory we are about to hand
   * out is worth refusing rather than normalising.
   */
  private relativeFramePath(workDir: string, framePath: string): string {
    const path = relative(workDir, framePath);
    if (!path || path.startsWith('..') || isAbsolute(path)) {
      throw new Error('The frame extractor returned a frame outside the work directory');
    }
    return path;
  }
}

function redactReading(reading: FrameReading): FrameReading {
  return {
    ...reading,
    ocrText: redactLikelySecrets(reading.ocrText),
    caption: redactLikelySecrets(reading.caption),
    uiElements: reading.uiElements.map(redactLikelySecrets),
  };
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
}
