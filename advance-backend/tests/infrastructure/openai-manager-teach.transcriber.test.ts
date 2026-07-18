import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { OpenAiManagerTeachTranscriber } from '../../src/infrastructure/ai/transcription/openai-manager-teach.transcriber';

describe('OpenAiManagerTeachTranscriber', () => {
  it('uploads bounded chunks and assigns chunk-level time windows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-teach-stt-'));
    const workDir = join(root, 'chunks');
    const prompts: string[] = [];
    let call = 0;
    const transcriber = new OpenAiManagerTeachTranscriber({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini-transcribe',
      chunkSeconds: 300,
      audioChunker: async input => {
        const first = join(input.workDir, 'chunk-0000.m4a');
        const second = join(input.workDir, 'chunk-0001.m4a');
        await writeFile(first, 'first audio');
        await writeFile(second, 'second audio');
        return [first, second];
      },
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        const form = init?.body as FormData;
        assert.equal(form.get('model'), 'gpt-4o-mini-transcribe');
        assert.equal(form.get('response_format'), 'json');
        assert.ok(form.get('file') instanceof Blob);
        prompts.push(String(form.get('prompt')));
        call += 1;
        return new Response(JSON.stringify({
          text: call === 1 ? 'Open Google Sheets.' : 'Update the owner column.',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch,
    });

    const result = await transcriber.transcribe({
      audioPath: join(root, 'audio.m4a'),
      ffmpegPath: '/usr/bin/ffmpeg',
      durationSeconds: 450,
      workDir,
    });

    assert.deepEqual(result.segments, [
      { start: 0, end: 300, text: 'Open Google Sheets.' },
      { start: 300, end: 450, text: 'Update the owner column.' },
    ]);
    assert.match(prompts[1] ?? '', /previous chunk ended with: Open Google Sheets/);
    assert.equal(result.timing, 'chunk');
    assert.equal(result.text, 'Open Google Sheets. Update the owner column.');
    await assert.rejects(readdir(workDir), /ENOENT/, 'temporary audio chunks must be removed');
    await rm(root, { recursive: true, force: true });
  });
});
