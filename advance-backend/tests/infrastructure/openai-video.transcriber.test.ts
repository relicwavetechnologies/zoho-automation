import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { OpenAiVideoTranscriber } from '../../src/infrastructure/ai/transcription/openai-video.transcriber';

describe('OpenAiVideoTranscriber', () => {
  it('uploads bounded chunks and assigns chunk-level time windows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-teach-stt-'));
    const workDir = join(root, 'chunks');
    const prompts: string[] = [];
    let call = 0;
    const transcriber = new OpenAiVideoTranscriber({
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

  it('retries a chunk through an OpenAI 500 instead of failing the ingestion', async () => {
    // The job-level retry would re-download the video and redo every frame and
    // OCR to reach this same request. Retrying the request costs a second.
    const root = await mkdtemp(join(tmpdir(), 'divo-teach-stt-retry-'));
    const waits: number[] = [];
    let calls = 0;
    const transcriber = new OpenAiVideoTranscriber({
      apiKey: 'sk-test',
      chunkSeconds: 300,
      sleepImpl: async ms => {
        waits.push(ms);
      },
      audioChunker: async input => {
        const only = join(input.workDir, 'chunk-0000.m4a');
        await writeFile(only, 'audio');
        return [only];
      },
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: { type: 'server_error' } }), {
            status: 500,
          });
        }
        return new Response(JSON.stringify({ text: 'Open the CRM.' }), { status: 200 });
      }) as typeof fetch,
    });

    const result = await transcriber.transcribe({
      audioPath: join(root, 'audio.m4a'),
      ffmpegPath: '/usr/bin/ffmpeg',
      durationSeconds: 120,
      workDir: join(root, 'chunks'),
    });

    assert.equal(calls, 2);
    assert.equal(result.text, 'Open the CRM.');
    assert.ok(waits[0]! > 0, 'the retry must back off rather than hammer the API');
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the narration it did get when one chunk cannot be recovered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-teach-stt-partial-'));
    let calls = 0;
    const transcriber = new OpenAiVideoTranscriber({
      apiKey: 'sk-test',
      chunkSeconds: 300,
      chunkAttempts: 1,
      sleepImpl: async () => {},
      audioChunker: async input => {
        const first = join(input.workDir, 'chunk-0000.m4a');
        const second = join(input.workDir, 'chunk-0001.m4a');
        await writeFile(first, 'a');
        await writeFile(second, 'b');
        return [first, second];
      },
      fetchImpl: (async () => {
        calls += 1;
        return calls === 2
          ? new Response('{}', { status: 500 })
          : new Response(JSON.stringify({ text: 'Open the CRM.' }), { status: 200 });
      }) as typeof fetch,
    });

    const result = await transcriber.transcribe({
      audioPath: join(root, 'audio.m4a'),
      ffmpegPath: '/usr/bin/ffmpeg',
      durationSeconds: 450,
      workDir: join(root, 'chunks'),
    });

    // Losing five minutes beats losing the whole teaching, and the gap is
    // recorded rather than silently presented as a complete transcript.
    assert.equal(result.segments.length, 1);
    assert.ok(result.warnings.some(warning => /5:00–7:30 could not be transcribed/.test(warning)));
    await rm(root, { recursive: true, force: true });
  });

  it('fails the job when no narration survived, rather than learning from silence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-teach-stt-empty-'));
    const transcriber = new OpenAiVideoTranscriber({
      apiKey: 'sk-test',
      chunkAttempts: 2,
      sleepImpl: async () => {},
      audioChunker: async input => {
        const only = join(input.workDir, 'chunk-0000.m4a');
        await writeFile(only, 'audio');
        return [only];
      },
      fetchImpl: (async () => new Response('{}', { status: 500 })) as typeof fetch,
    });

    await assert.rejects(
      transcriber.transcribe({
        audioPath: join(root, 'audio.m4a'),
        ffmpegPath: '/usr/bin/ffmpeg',
        durationSeconds: 120,
        workDir: join(root, 'chunks'),
      }),
      /OpenAI transcription failed \(500\)/,
    );
    await rm(root, { recursive: true, force: true });
  });

  it('does not retry a request OpenAI has refused outright', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-teach-stt-4xx-'));
    let calls = 0;
    const transcriber = new OpenAiVideoTranscriber({
      apiKey: 'sk-test',
      sleepImpl: async () => {},
      audioChunker: async input => {
        const only = join(input.workDir, 'chunk-0000.m4a');
        await writeFile(only, 'audio');
        return [only];
      },
      fetchImpl: (async () => {
        calls += 1;
        return new Response('{}', { status: 401 });
      }) as typeof fetch,
    });

    await assert.rejects(
      transcriber.transcribe({
        audioPath: join(root, 'audio.m4a'),
        ffmpegPath: '/usr/bin/ffmpeg',
        durationSeconds: 60,
        workDir: join(root, 'chunks'),
      }),
      /401/,
    );
    // Retrying a bad key only burns the upload again.
    assert.equal(calls, 1);
    await rm(root, { recursive: true, force: true });
  });
});
