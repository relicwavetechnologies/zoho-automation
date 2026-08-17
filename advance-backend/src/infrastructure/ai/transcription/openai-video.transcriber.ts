import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { z } from 'zod';
import type {
  VideoTranscript,
  TranscriptSegment,
  VideoTranscriber,
} from '../../../application/video-understanding/video-understanding.types';

const transcriptionResponseSchema = z.object({ text: z.string() });
const MAX_OPENAI_FILE_BYTES = 24 * 1_024 * 1_024;
const DEFAULT_CHUNK_ATTEMPTS = 3;
const CHUNK_RETRY_DELAYS_MS = [1_000, 4_000, 10_000] as const;

/**
 * Whether OpenAI is having a bad moment or is refusing this request outright.
 *
 * Their 500s are routine and clear on a second attempt seconds later; retrying
 * a 400 or a 401 just burns the upload again. Rate limits are retryable by
 * definition, and the caller honours `Retry-After` when one is offered.
 */
function isRetryableTranscriptionStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Network-level faults never reach a status code, but are always worth a retry. */
function isRetryableTransportError(error: unknown): boolean {
  return /aborted|timeout|timed out|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed/i
    .test(error instanceof Error ? `${error.name} ${error.message}` : String(error));
}

class RetryableTranscriptionError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'RetryableTranscriptionError';
  }
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1_000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.min(60_000, at - Date.now()));
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function describeWindow(start: number, end: number): string {
  const format = (value: number) => {
    const minutes = Math.floor(value / 60);
    const seconds = Math.round(value % 60);
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };
  return `${format(start)}–${format(end)}`;
}

export interface OpenAiVideoTranscriberOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly chunkSeconds?: number;
  readonly requestTimeoutMs?: number;
  /** Attempts per audio chunk before the chunk is given up on. */
  readonly chunkAttempts?: number;
  readonly fetchImpl?: typeof fetch;
  /** Injected so tests exercise the backoff without waiting for it. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly audioChunker?: (input: {
    audioPath: string;
    ffmpegPath: string;
    workDir: string;
    chunkSeconds: number;
  }) => Promise<readonly string[]>;
}

export class OpenAiVideoTranscriber implements VideoTranscriber {
  private readonly model: string;
  private readonly chunkSeconds: number;

  constructor(private readonly options: OpenAiVideoTranscriberOptions) {
    if (!options.apiKey.trim()) throw new Error('OpenAI transcription is not configured');
    this.model = options.model?.trim() || 'gpt-4o-mini-transcribe';
    this.chunkSeconds = options.chunkSeconds ?? 300;
  }

  async transcribe(input: {
    audioPath: string;
    ffmpegPath: string;
    durationSeconds: number;
    workDir: string;
  }): Promise<VideoTranscript> {
    await rm(input.workDir, { recursive: true, force: true });
    await mkdir(input.workDir, { recursive: true });

    try {
      const chunkPaths = this.options.audioChunker
        ? await this.options.audioChunker({
          audioPath: input.audioPath,
          ffmpegPath: input.ffmpegPath,
          workDir: input.workDir,
          chunkSeconds: this.chunkSeconds,
        })
        : await chunkAudio({
          audioPath: input.audioPath,
          ffmpegPath: input.ffmpegPath,
          workDir: input.workDir,
          chunkSeconds: this.chunkSeconds,
        });
      if (chunkPaths.length === 0) throw new Error('Audio chunking produced no files');

      const segments: TranscriptSegment[] = [];
      const warnings: string[] = [
        'Transcript timing is available at audio-chunk level; this model does not return native word or segment timestamps.',
      ];
      let previousText = '';
      let lastFailure: unknown;

      for (const [index, chunkPath] of chunkPaths.entries()) {
        const metadata = await stat(chunkPath);
        if (metadata.size > MAX_OPENAI_FILE_BYTES) {
          throw new Error(`Audio chunk exceeds the OpenAI upload limit: ${basename(chunkPath)}`);
        }
        const start = index * this.chunkSeconds;
        const end = Math.min(input.durationSeconds, (index + 1) * this.chunkSeconds);

        let text: string;
        try {
          text = await this.transcribeChunkWithRetries(chunkPath, previousText);
        } catch (error) {
          // One unlucky chunk must not destroy the rest of the narration. A
          // manager who explained a twenty-minute workflow keeps nineteen
          // minutes of it, and the gap is recorded rather than hidden.
          lastFailure = error;
          warnings.push(
            `Audio from ${describeWindow(start, end)} could not be transcribed: ${String(error)}`,
          );
          continue;
        }

        if (text) {
          segments.push({ start, end, text });
          previousText = text.slice(-800);
        }
      }

      // Nothing at all came back. Narration is the signal Teach actually
      // learns from, so inventing a rule from silent screenshots would be
      // worse than failing — throw and let the queue retry the job.
      if (segments.length === 0 && lastFailure !== undefined) {
        throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure));
      }

      return {
        provider: 'openai',
        model: this.model,
        timing: 'chunk',
        durationSeconds: input.durationSeconds,
        segments,
        text: segments.map(segment => segment.text).join(' ').trim(),
        warnings,
      };
    } finally {
      await rm(input.workDir, { recursive: true, force: true });
    }
  }

  /**
   * Retry one chunk through an upstream wobble.
   *
   * A single OpenAI 500 used to fail the whole ingestion job, and the queue's
   * job-level retry then re-downloaded the video, re-extracted every frame and
   * re-ran all the OCR to reach the same request again — expensive, slow, and
   * no more likely to succeed. Retrying the one request that actually failed
   * costs seconds and recovers almost all of these.
   */
  private async transcribeChunkWithRetries(
    chunkPath: string,
    previousText: string,
  ): Promise<string> {
    const attempts = Math.max(1, this.options.chunkAttempts ?? DEFAULT_CHUNK_ATTEMPTS);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.transcribeChunk(chunkPath, previousText);
      } catch (error) {
        const retryable =
          error instanceof RetryableTranscriptionError || isRetryableTransportError(error);
        if (!retryable || attempt === attempts) throw error;
        lastError = error;
        const backoff =
          CHUNK_RETRY_DELAYS_MS[attempt - 1] ?? CHUNK_RETRY_DELAYS_MS.at(-1)!;
        const wait =
          error instanceof RetryableTranscriptionError && error.retryAfterMs !== undefined
            ? Math.max(error.retryAfterMs, backoff)
            : backoff;
        await (this.options.sleepImpl ?? sleep)(wait);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async transcribeChunk(chunkPath: string, previousText: string): Promise<string> {
    const bytes = await readFile(chunkPath);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/mp4' }), basename(chunkPath));
    form.append('model', this.model);
    form.append('response_format', 'json');
    form.append(
      'prompt',
      [
        'This audio is a manager narrating a workplace screen-recording workflow.',
        'Preserve application names, field names, labels, acronyms, numbers, and step order.',
        previousText ? `The previous chunk ended with: ${previousText}` : '',
      ].filter(Boolean).join(' '),
    );

    const response = await (this.options.fetchImpl ?? fetch)('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.apiKey.trim()}` },
      body: form,
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 120_000),
    });
    const raw = await response.text();
    if (!response.ok) {
      const message = `OpenAI transcription failed (${response.status}): ${raw.slice(0, 500)}`;
      throw isRetryableTranscriptionStatus(response.status)
        ? new RetryableTranscriptionError(
          message,
          parseRetryAfterMs(response.headers.get('retry-after')),
        )
        : new Error(message);
    }
    return transcriptionResponseSchema.parse(JSON.parse(raw)).text.trim();
  }
}

async function chunkAudio(input: {
  audioPath: string;
  ffmpegPath: string;
  workDir: string;
  chunkSeconds: number;
}): Promise<readonly string[]> {
  const pattern = join(input.workDir, 'chunk-%04d.m4a');
  await runFfmpeg(input.ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', input.audioPath,
    '-map', '0:a:0',
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'aac',
    '-b:a', '48k',
    '-f', 'segment',
    '-segment_time', String(input.chunkSeconds),
    '-segment_start_number', '0',
    '-reset_timestamps', '1',
    pattern,
  ]);
  return (await readdir(input.workDir))
    .filter(name => /^chunk-\d+\.m4a$/.test(name))
    .sort()
    .map(name => join(input.workDir, name));
}

async function runFfmpeg(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-20_000);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`Audio chunking failed with exit code ${code}: ${stderr.trim().slice(-2_000)}`));
    });
  });
}
