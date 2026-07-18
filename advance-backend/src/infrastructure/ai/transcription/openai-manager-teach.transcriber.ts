import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { z } from 'zod';
import type {
  ManagerTeachTranscript,
  ManagerTeachTranscriptSegment,
  ManagerTeachTranscriber,
} from '../../../application/persona-learning/manager-teach-media.types';

const transcriptionResponseSchema = z.object({ text: z.string() });
const MAX_OPENAI_FILE_BYTES = 24 * 1_024 * 1_024;

export interface OpenAiManagerTeachTranscriberOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly chunkSeconds?: number;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly audioChunker?: (input: {
    audioPath: string;
    ffmpegPath: string;
    workDir: string;
    chunkSeconds: number;
  }) => Promise<readonly string[]>;
}

export class OpenAiManagerTeachTranscriber implements ManagerTeachTranscriber {
  private readonly model: string;
  private readonly chunkSeconds: number;

  constructor(private readonly options: OpenAiManagerTeachTranscriberOptions) {
    if (!options.apiKey.trim()) throw new Error('OpenAI transcription is not configured');
    this.model = options.model?.trim() || 'gpt-4o-mini-transcribe';
    this.chunkSeconds = options.chunkSeconds ?? 300;
  }

  async transcribe(input: {
    audioPath: string;
    ffmpegPath: string;
    durationSeconds: number;
    workDir: string;
  }): Promise<ManagerTeachTranscript> {
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

      const segments: ManagerTeachTranscriptSegment[] = [];
      let previousText = '';
      for (const [index, chunkPath] of chunkPaths.entries()) {
        const metadata = await stat(chunkPath);
        if (metadata.size > MAX_OPENAI_FILE_BYTES) {
          throw new Error(`Audio chunk exceeds the OpenAI upload limit: ${basename(chunkPath)}`);
        }
        const text = await this.transcribeChunk(chunkPath, previousText);
        if (text) {
          segments.push({
            start: index * this.chunkSeconds,
            end: Math.min(input.durationSeconds, (index + 1) * this.chunkSeconds),
            text,
          });
          previousText = text.slice(-800);
        }
      }

      return {
        provider: 'openai',
        model: this.model,
        timing: 'chunk',
        durationSeconds: input.durationSeconds,
        segments,
        text: segments.map(segment => segment.text).join(' ').trim(),
        warnings: [
          'Transcript timing is available at audio-chunk level; this model does not return native word or segment timestamps.',
        ],
      };
    } finally {
      await rm(input.workDir, { recursive: true, force: true });
    }
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
      throw new Error(`OpenAI transcription failed (${response.status}): ${raw.slice(0, 500)}`);
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
