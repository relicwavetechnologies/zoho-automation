import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { VideoUnderstandingService } from '../../src/application/video-understanding/video-understanding.service';
import type { VideoExtraction } from '../../src/application/video-understanding/video-understanding.types';
import type { Logger } from '../../src/shared/logger';

const noopLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLogger,
};

const videoFacts = {
  durationSeconds: 20, container: 'mov', codec: 'h264', width: 1600, height: 900,
  fps: 30, sizeBytes: 100,
};

const extractionFacts = {
  strategy: 'scene', threshold: 0.12, framesEmitted: 2, framesBeforePrune: 3,
  framesPruned: 1, framesDeduped: 1, dedupDistance: 5, motionSignalLevel: 'low',
  elapsedMs: 100, ffmpegPath: '/usr/bin/ffmpeg',
};

describe('VideoUnderstandingService', () => {
  it('reads frames in order, keeps chunk timing, and survives one unreadable frame', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-video-'));
    const workDir = join(root, 'evidence');
    const progress: number[] = [];
    let reads = 0;

    const service = new VideoUnderstandingService({
      extractor: {
        extract: async ({ outputDir }): Promise<VideoExtraction> => {
          await mkdir(outputDir, { recursive: true });
          const frame1 = join(outputDir, 'frame_0001.jpg');
          const frame2 = join(outputDir, 'frame_0002.jpg');
          const audio = join(outputDir, 'audio.m4a');
          await Promise.all([
            writeFile(frame1, 'first'), writeFile(frame2, 'second'), writeFile(audio, 'audio'),
          ]);
          return {
            outputDir,
            strategy: 'scene',
            frames: [{ path: frame1, bytes: 5 }, { path: frame2, bytes: 6 }],
            video: videoFacts,
            extraction: extractionFacts,
            audio: {
              path: audio, codec: 'aac', channels: 1, sampleRateHz: 16_000,
              durationSeconds: 20, sizeBytes: 5, skippedReason: null,
            },
          };
        },
      },
      transcriber: {
        transcribe: async () => ({
          provider: 'openai' as const,
          model: 'gpt-4o-mini-transcribe',
          timing: 'chunk' as const,
          durationSeconds: 20,
          segments: [{ start: 0, end: 20, text: 'Open Sheets and update the owner.' }],
          text: 'Open Sheets and update the owner.',
          warnings: ['chunk timing'],
        }),
      },
      reader: {
        read: async () => {
          reads += 1;
          if (reads === 2) throw new Error('temporary provider error');
          return {
            ocrText: 'Owner', caption: 'Google Sheets', uiElements: ['Owner'],
            confidence: 0.9, warnings: [], provider: 'openrouter',
            model: 'qwen/qwen3-vl-32b-instruct',
          };
        },
      },
      logger: noopLogger,
      readConcurrency: 1,
      transcriptionModel: 'gpt-4o-mini-transcribe',
    });

    const understanding = await service.understand({
      videoPath: join(root, 'raw.mov'),
      workDir,
      onProgress: async value => { progress.push(value); },
    });

    // Relative, so the understanding can be stored and moved between machines
    // without carrying this server's directory layout inside it.
    assert.deepEqual(understanding.frames.map(frame => frame.path), ['frame_0001.jpg', 'frame_0002.jpg']);
    assert.deepEqual(understanding.frames.map(frame => frame.sequence), [1, 2]);
    // A frame that could not be read stays in place as an empty reading rather
    // than vanishing, which would silently renumber everything after it.
    assert.equal(understanding.frames[1]?.reading.ocrText, '');
    assert.equal(understanding.frames[1]?.reading.model, 'unavailable');
    assert.equal(understanding.transcript.timing, 'chunk');
    assert.deepEqual(understanding.transcript.segments[0], {
      start: 0, end: 20, text: 'Open Sheets and update the owner.',
    });
    assert.equal(understanding.warnings.length, 1);
    // Its own scale, not a slice of some caller's bar.
    assert.equal(progress.at(-1), 100);

    await rm(root, { recursive: true, force: true });
  });

  it('reports the silence rather than inventing a transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-video-silent-'));
    const service = new VideoUnderstandingService({
      extractor: {
        extract: async ({ outputDir }): Promise<VideoExtraction> => {
          await mkdir(outputDir, { recursive: true });
          const frame = join(outputDir, 'frame.jpg');
          await writeFile(frame, 'frame');
          return {
            outputDir, strategy: 'fps', frames: [{ path: frame, bytes: 5 }],
            video: videoFacts, extraction: extractionFacts, audio: null,
          };
        },
      },
      transcriber: { transcribe: async () => { throw new Error('must not be called'); } },
      reader: {
        read: async () => ({
          ocrText: 'Owner', caption: 'Sheets', uiElements: [], confidence: 0.5,
          warnings: [], provider: 'openrouter', model: 'qwen/qwen3-vl-32b-instruct',
        }),
      },
      logger: noopLogger,
      readConcurrency: 1,
      transcriptionModel: 'gpt-4o-mini-transcribe',
    });

    const understanding = await service.understand({
      videoPath: join(root, 'raw.mp4'),
      workDir: join(root, 'evidence'),
    });

    assert.deepEqual(understanding.transcript.segments, []);
    assert.match(understanding.warnings[0] ?? '', /did not contain an audio track/);
    await rm(root, { recursive: true, force: true });
  });

  it('fails the whole reading when no frame could be read, and leaves nothing behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-video-fail-'));
    const workDir = join(root, 'evidence');
    const service = new VideoUnderstandingService({
      extractor: {
        extract: async ({ outputDir }): Promise<VideoExtraction> => {
          await mkdir(outputDir, { recursive: true });
          const frame = join(outputDir, 'frame.jpg');
          await writeFile(frame, 'frame');
          return {
            outputDir, strategy: 'fps', frames: [{ path: frame, bytes: 5 }],
            video: videoFacts, extraction: extractionFacts, audio: null,
          };
        },
      },
      transcriber: {} as never,
      reader: { read: async () => { throw new Error('vision unavailable'); } },
      logger: noopLogger,
      readConcurrency: 2,
      transcriptionModel: 'gpt-4o-mini-transcribe',
    });

    await assert.rejects(
      service.understand({ videoPath: join(root, 'raw.mp4'), workDir }),
      /Reading failed for every extracted frame/,
    );
    // A retry must not find half of this attempt's frames waiting for it.
    await assert.rejects(access(workDir), /ENOENT/);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a frame written outside the work directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-video-escape-'));
    const workDir = join(root, 'evidence');
    const service = new VideoUnderstandingService({
      extractor: {
        extract: async ({ outputDir }): Promise<VideoExtraction> => {
          await mkdir(outputDir, { recursive: true });
          const outside = join(root, 'elsewhere.jpg');
          await writeFile(outside, 'frame');
          return {
            outputDir, strategy: 'fps', frames: [{ path: outside, bytes: 5 }],
            video: videoFacts, extraction: extractionFacts, audio: null,
          };
        },
      },
      transcriber: {} as never,
      reader: {
        read: async () => ({
          ocrText: '', caption: '', uiElements: [], confidence: 0,
          warnings: [], provider: 'openrouter', model: 'qwen/qwen3-vl-32b-instruct',
        }),
      },
      logger: noopLogger,
      readConcurrency: 1,
      transcriptionModel: 'gpt-4o-mini-transcribe',
    });

    await assert.rejects(
      service.understand({ videoPath: join(root, 'raw.mp4'), workDir }),
      /outside the work directory/,
    );
    await rm(root, { recursive: true, force: true });
  });
});
