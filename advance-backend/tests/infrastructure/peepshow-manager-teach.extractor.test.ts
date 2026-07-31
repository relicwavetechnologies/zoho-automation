import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PeepshowManagerTeachExtractor } from '../../src/infrastructure/media/peepshow-manager-teach.extractor';

describe('PeepshowManagerTeachExtractor', () => {
  it('runs the constrained CLI contract and validates its JSON manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-peepshow-'));
    const cliPath = join(root, 'mock-peepshow.cjs');
    await writeFile(cliPath, `
const args = process.argv.slice(2);
for (const flag of ['--emit', '--no-transcribe', '--no-report', '--no-manifest', '--no-index', '--no-auto-sinks']) {
  if (!args.includes(flag)) process.exit(9);
}
if (process.env.PEEPSHOW_TELEMETRY !== '0' || process.env.DO_NOT_TRACK !== '1') process.exit(10);
const outputDir = args[args.indexOf('--output') + 1];
process.stdout.write(JSON.stringify({
  outputDir,
  strategy: 'scene',
  frames: [{ path: outputDir + '/frame_0001.jpg', bytes: 100 }],
  video: { durationSeconds: 12, container: 'mov', codec: 'h264', width: 1600, height: 900, fps: 30, sizeBytes: 500 },
  extraction: {
    strategy: 'scene', threshold: 0.12, framesEmitted: 1, framesBeforePrune: 2,
    framesPruned: 1, framesDeduped: 1, dedupDistance: 5, motionSignalLevel: 'low',
    elapsedMs: 25, ffmpegPath: '/bundled/ffmpeg'
  },
  audio: { path: outputDir + '/audio.m4a', codec: 'aac', channels: 1, sampleRateHz: 16000, durationSeconds: 12, sizeBytes: 200, skippedReason: null }
}));
`);
    const extractor = new PeepshowManagerTeachExtractor({
      maxFrames: 40,
      width: 1_600,
      sceneThreshold: 0.12,
      cliPath,
      timeoutMs: 5_000,
    });

    const result = await extractor.extract({
      videoPath: join(root, 'raw.mov'),
      outputDir: join(root, 'evidence'),
    });
    assert.equal(result.frames.length, 1);
    assert.equal(result.extraction.ffmpegPath, '/bundled/ffmpeg');
    assert.equal(result.audio?.durationSeconds, 12);
    await rm(root, { recursive: true, force: true });
  });
});
