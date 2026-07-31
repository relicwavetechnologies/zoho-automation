import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type {
  ManagerTeachMediaExtraction,
  ManagerTeachMediaExtractor,
} from '../../application/persona-learning/manager-teach-media.types';

const nullableNumber = z.number().finite().nullable().default(null);
const nullableString = z.string().nullable().default(null);

const peepshowResultSchema = z.object({
  outputDir: z.string().min(1),
  strategy: z.enum(['scene', 'fps', 'transnet']),
  frames: z.array(z.object({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  })),
  video: z.object({
    durationSeconds: z.number().finite().nonnegative(),
    container: nullableString,
    codec: nullableString,
    width: z.number().int().positive().nullable().default(null),
    height: z.number().int().positive().nullable().default(null),
    fps: nullableNumber,
    sizeBytes: z.number().int().nonnegative().nullable().default(null),
  }).passthrough(),
  extraction: z.object({
    strategy: z.string(),
    threshold: nullableNumber,
    framesEmitted: z.number().int().nonnegative(),
    framesBeforePrune: z.number().int().nonnegative(),
    framesPruned: z.number().int().nonnegative(),
    framesDeduped: z.number().int().nonnegative(),
    dedupDistance: nullableNumber,
    motionSignalLevel: nullableString,
    elapsedMs: nullableNumber,
    ffmpegPath: z.string().min(1),
  }).passthrough(),
  audio: z.object({
    path: nullableString,
    codec: nullableString,
    channels: z.number().int().positive().nullable().default(null),
    sampleRateHz: z.number().int().positive().nullable().default(null),
    durationSeconds: z.number().finite().nonnegative().default(0),
    sizeBytes: z.number().int().nonnegative().default(0),
    skippedReason: nullableString,
  }).passthrough().nullable().default(null),
});

export interface PeepshowManagerTeachExtractorOptions {
  readonly maxFrames: number;
  readonly minFrames?: number;
  readonly width?: number;
  readonly sceneThreshold: number;
  readonly timeoutMs?: number;
  readonly cliPath?: string;
}

export class PeepshowManagerTeachExtractor implements ManagerTeachMediaExtractor {
  private readonly cliPath: string;

  constructor(private readonly options: PeepshowManagerTeachExtractorOptions) {
    const packageDir = dirname(require.resolve('peepshow/package.json'));
    this.cliPath = options.cliPath ?? join(packageDir, 'dist', 'cli.js');
  }

  async extract(input: { videoPath: string; outputDir: string }): Promise<ManagerTeachMediaExtraction> {
    const stdout = await runProcess(
      process.execPath,
      [
        this.cliPath,
        input.videoPath,
        '--output', input.outputDir,
        '--emit', 'json',
        '--quiet',
        '--threshold', String(this.options.sceneThreshold),
        '--max', String(this.options.maxFrames),
        '--min', String(this.options.minFrames ?? Math.min(4, this.options.maxFrames)),
        '--width', String(this.options.width ?? 1_600),
        '--format', 'jpg',
        '--no-transcribe',
        '--no-report',
        '--no-manifest',
        '--no-index',
        '--no-auto-sinks',
      ],
      this.options.timeoutMs ?? 30 * 60_000,
      {
        ...process.env,
        PEEPSHOW_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
      },
    );

    const parsed = peepshowResultSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) {
      throw new Error(`Peepshow returned an invalid media manifest: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}

async function runProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Peepshow timed out after ${Math.round(timeoutMs / 1_000)} seconds`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 5_000_000) {
        child.kill('SIGKILL');
        finish(new Error('Peepshow output exceeded the safe response limit'));
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-20_000);
    });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (code === 0) finish();
      else finish(new Error(`Peepshow failed with exit code ${code}: ${stderr.trim().slice(-2_000)}`));
    });
  });
}
