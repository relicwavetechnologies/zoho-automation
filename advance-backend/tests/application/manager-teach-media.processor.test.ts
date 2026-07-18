import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ManagerTeachMediaProcessor } from '../../src/application/persona-learning/manager-teach-media.processor';
import type { Logger } from '../../src/shared/logger';

const noopLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLogger,
};

describe('ManagerTeachMediaProcessor', () => {
  it('writes ordered frame OCR and chunk-timed transcript evidence atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-teach-media-'));
    const evidenceDir = join(root, 'evidence');
    const progress: number[] = [];
    let ocrCall = 0;
    const processor = new ManagerTeachMediaProcessor({
      extractor: {
        extract: async ({ outputDir }) => {
          await mkdir(outputDir, { recursive: true });
          const frame1 = join(outputDir, 'frame_0001.jpg');
          const frame2 = join(outputDir, 'frame_0002.jpg');
          const audio = join(outputDir, 'audio.m4a');
          await Promise.all([
            writeFile(frame1, 'first'),
            writeFile(frame2, 'second'),
            writeFile(audio, 'audio'),
          ]);
          return {
            outputDir,
            strategy: 'scene' as const,
            frames: [{ path: frame1, bytes: 5 }, { path: frame2, bytes: 6 }],
            video: {
              durationSeconds: 20, container: 'mov', codec: 'h264', width: 1600, height: 900,
              fps: 30, sizeBytes: 100,
            },
            extraction: {
              strategy: 'scene', threshold: 0.12, framesEmitted: 2, framesBeforePrune: 3,
              framesPruned: 1, framesDeduped: 1, dedupDistance: 5, motionSignalLevel: 'low',
              elapsedMs: 100, ffmpegPath: '/usr/bin/ffmpeg',
            },
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
      ocr: {
        extract: async () => {
          ocrCall += 1;
          if (ocrCall === 2) throw new Error('temporary provider error');
          return {
            ocrText: 'Owner', caption: 'Google Sheets', uiElements: ['Owner'], confidence: 0.9,
            warnings: [], provider: 'openrouter' as const, model: 'qwen/qwen3-vl-32b-instruct',
          };
        },
      },
      logger: noopLogger,
      ocrConcurrency: 1,
      transcriptionModel: 'gpt-4o-mini-transcribe',
    });

    const result = await processor.process({
      teachSessionId: 'teach-1', companyId: 'company-1', departmentId: 'department-1',
      managerId: 'manager-1', source: 'recording', originalFileName: 'workflow.mov',
      videoPath: join(root, 'raw.mov'), evidenceDir,
      assertActive: async () => {},
      onProgress: async value => { progress.push(value); },
    });

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as any;
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(manifest.frames.map((frame: any) => frame.path), ['frame_0001.jpg', 'frame_0002.jpg']);
    assert.deepEqual(manifest.frames.map((frame: any) => frame.sequence), [1, 2]);
    assert.equal('timestamp' in manifest.frames[0], false, 'frame timing must not be invented');
    assert.equal(manifest.transcript.timing, 'chunk');
    assert.deepEqual(manifest.transcript.segments[0], {
      start: 0, end: 20, text: 'Open Sheets and update the owner.',
    });
    assert.equal(manifest.warnings.length, 1);
    assert.equal(result.warningCount, 1);
    assert.equal(progress.at(-1), 95);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects evidence when every frame OCR call fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-teach-media-fail-'));
    const evidenceDir = join(root, 'evidence');
    const processor = new ManagerTeachMediaProcessor({
      extractor: {
        extract: async ({ outputDir }) => {
          await mkdir(outputDir, { recursive: true });
          const frame = join(outputDir, 'frame.jpg');
          await writeFile(frame, 'frame');
          return {
            outputDir, strategy: 'fps' as const, frames: [{ path: frame, bytes: 5 }],
            video: { durationSeconds: 1, container: 'mov', codec: 'h264', width: 100, height: 100, fps: 1, sizeBytes: 5 },
            extraction: {
              strategy: 'fps', threshold: null, framesEmitted: 1, framesBeforePrune: 1,
              framesPruned: 0, framesDeduped: 0, dedupDistance: null, motionSignalLevel: null,
              elapsedMs: 1, ffmpegPath: '/usr/bin/ffmpeg',
            },
            audio: null,
          };
        },
      },
      transcriber: {} as never,
      ocr: { extract: async () => { throw new Error('OCR unavailable'); } },
      logger: noopLogger,
      ocrConcurrency: 2,
      transcriptionModel: 'gpt-4o-mini-transcribe',
    });

    await assert.rejects(processor.process({
      teachSessionId: 'teach-2', companyId: 'company-1', departmentId: 'department-1',
      managerId: 'manager-1', source: 'upload', originalFileName: null,
      videoPath: join(root, 'raw.mp4'), evidenceDir,
      assertActive: async () => {}, onProgress: async () => {},
    }), /OCR failed for every extracted frame/);
    await assert.rejects(readFile(join(evidenceDir, 'evidence-manifest.json')), /ENOENT/);
    await rm(root, { recursive: true, force: true });
  });
});
