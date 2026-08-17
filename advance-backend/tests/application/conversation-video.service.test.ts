import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import {
  ConversationVideoError,
  ConversationVideoService,
} from '../../src/application/conversation-video/conversation-video.service';
import {
  ConversationVideoStore,
  ConversationVideoTooLargeError,
} from '../../src/application/conversation-video/conversation-video.store';
import type { VideoUnderstanding } from '../../src/application/video-understanding/video-understanding.types';
import type { Logger } from '../../src/shared/logger';

const noopLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLogger,
};

const owner = {
  companyId: 'company-1',
  userId: 'user-1',
  channel: 'web',
  threadId: 'web_thread1234',
};

const understanding: VideoUnderstanding = {
  video: {
    durationSeconds: 12, container: 'mp4', codec: 'h264',
    width: 100, height: 100, fps: 30, sizeBytes: 10,
  },
  extraction: {
    strategy: 'scene', threshold: null, framesEmitted: 1, framesBeforePrune: 1,
    framesPruned: 0, framesDeduped: 0, dedupDistance: null, motionSignalLevel: null,
    elapsedMs: 1, ffmpegPath: '/usr/bin/ffmpeg',
  },
  frames: [{
    sequence: 1, path: 'frame_0001.jpg', bytes: 4,
    reading: {
      ocrText: 'Invoice 4182', caption: 'Zoho Books', uiElements: [],
      confidence: 0.9, warnings: [], provider: 'openrouter', model: 'qwen',
    },
  }],
  transcript: {
    provider: 'openai', model: 'gpt-4o-mini-transcribe', timing: 'chunk',
    durationSeconds: 12,
    segments: [{ start: 0, end: 12, text: 'Open the invoice and set the owner.' }],
    text: 'Open the invoice and set the owner.',
    warnings: [],
  },
  warnings: [],
};

function build(options: {
  root: string;
  maxBytes?: number;
  understand?: () => Promise<VideoUnderstanding>;
}) {
  const store = new ConversationVideoStore({
    rootDir: options.root,
    maxBytes: options.maxBytes ?? 1_000_000,
  });
  const service = new ConversationVideoService({
    store,
    understanding: {
      understand: options.understand ?? (async () => understanding),
    } as never,
    logger: noopLogger,
  });
  return { store, service };
}

describe('ConversationVideoService', () => {
  it('reads a video once, then serves the reading and throws the recording away', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-'));
    let reads = 0;
    const { service } = build({
      root,
      understand: async () => { reads += 1; return understanding; },
    });

    const record = await service.accept({
      owner,
      fileName: 'workflow.mp4',
      mimeType: 'video/mp4',
      body: Readable.from([Buffer.from('a video')]),
    });
    assert.equal(record.sizeBytes, 7);

    const first = await service.understandingFor({ owner, videoId: record.videoId });
    const second = await service.understandingFor({ owner, videoId: record.videoId });
    assert.equal(first.transcript.text, 'Open the invoice and set the owner.');
    assert.equal(second.transcript.text, first.transcript.text);
    assert.equal(reads, 1, 'a second ask must not re-read the video');

    // We keep what was understood, never the recording.
    const files = await readdir(join(root, owner.companyId, record.videoId));
    assert.equal(files.some(name => name.startsWith('source.')), false);
    assert.equal(files.includes('understanding.json'), true);

    await rm(root, { recursive: true, force: true });
  });

  it('refuses a video belonging to another conversation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-owner-'));
    const { service } = build({ root });
    const record = await service.accept({
      owner,
      fileName: 'workflow.mp4',
      mimeType: 'video/mp4',
      body: Readable.from([Buffer.from('a video')]),
    });

    await assert.rejects(
      service.understandingFor({
        owner: { ...owner, threadId: 'web_someoneelse' },
        videoId: record.videoId,
      }),
      (error: unknown) => error instanceof ConversationVideoError && error.code === 'video_not_found',
    );
    await assert.rejects(
      service.understandingFor({ owner: { ...owner, userId: 'user-2' }, videoId: record.videoId }),
      (error: unknown) => error instanceof ConversationVideoError && error.code === 'video_not_found',
    );
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a container it has not thought about', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-mime-'));
    const { service } = build({ root });
    await assert.rejects(
      service.accept({
        owner,
        fileName: 'workflow.mkv',
        mimeType: 'video/x-matroska',
        body: Readable.from([Buffer.from('x')]),
      }),
      (error: unknown) => error instanceof ConversationVideoError && error.code === 'unsupported_video',
    );
    await rm(root, { recursive: true, force: true });
  });

  it('stops a body that keeps growing, and leaves nothing behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-large-'));
    const { service } = build({ root, maxBytes: 8 });
    await assert.rejects(
      service.accept({
        owner,
        fileName: 'big.mp4',
        mimeType: 'video/mp4',
        body: Readable.from([Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4)]),
      }),
      ConversationVideoTooLargeError,
    );
    const companies = await readdir(root).catch(() => []);
    for (const company of companies) {
      assert.deepEqual(await readdir(join(root, company)), [], 'a refused upload leaves no directory');
    }
    await rm(root, { recursive: true, force: true });
  });

  it('turns a failed reading into a refusal a caller can act on', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-fail-'));
    const { service } = build({
      root,
      understand: async () => { throw new Error('ffmpeg exploded'); },
    });
    const record = await service.accept({
      owner,
      fileName: 'workflow.mp4',
      mimeType: 'video/mp4',
      body: Readable.from([Buffer.from('a video')]),
    });
    await assert.rejects(
      service.understandingFor({ owner, videoId: record.videoId }),
      (error: unknown) => error instanceof ConversationVideoError && error.code === 'video_unreadable',
    );
    await rm(root, { recursive: true, force: true });
  });

  it('prunes a reading once it is past the window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-prune-'));
    const { service } = build({ root });
    const record = await service.accept({
      owner,
      fileName: 'workflow.mp4',
      mimeType: 'video/mp4',
      body: Readable.from([Buffer.from('a video')]),
    });
    await service.understandingFor({ owner, videoId: record.videoId });

    assert.equal(await service.prune(60_000), 0, 'a fresh reading survives');
    assert.equal(await service.prune(0), 1);
    await assert.rejects(access(join(root, owner.companyId, record.videoId)), /ENOENT/);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses an id shaped like a path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-path-'));
    const { store } = build({ root });
    await writeFile(join(root, 'secret'), 'no');
    assert.equal(await store.metaFor('company-1', '../../secret'), null);
    await rm(root, { recursive: true, force: true });
  });
});

describe('conversation video backpressure', () => {
  it('never reads more videos at once than it is allowed to', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-cap-'));
    let inFlight = 0;
    let peak = 0;
    const store = new ConversationVideoStore({ rootDir: root, maxBytes: 1_000_000 });
    const service = new ConversationVideoService({
      store,
      logger: noopLogger,
      maxConcurrentReads: 2,
      understanding: {
        understand: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise(resolve => { setTimeout(resolve, 15); });
          inFlight -= 1;
          return understanding;
        },
      } as never,
    });

    const records = await Promise.all([1, 2, 3, 4, 5].map(index => service.accept({
      owner,
      fileName: `workflow-${index}.mp4`,
      mimeType: 'video/mp4',
      body: Readable.from([Buffer.from('a video')]),
    })));
    await Promise.all(records.map(record => service.understandingFor({ owner, videoId: record.videoId })));

    assert.equal(peak, 2, `expected at most 2 concurrent readings, saw ${peak}`);
    await rm(root, { recursive: true, force: true });
  });

  it('forgets a finished reading rather than holding its progress forever', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-progress-'));
    const { service } = build({ root });
    const record = await service.accept({
      owner,
      fileName: 'workflow.mp4',
      mimeType: 'video/mp4',
      body: Readable.from([Buffer.from('a video')]),
    });
    await service.understandingFor({ owner, videoId: record.videoId });
    assert.equal(service.progressFor(record.videoId), null);
    await rm(root, { recursive: true, force: true });
  });
});

describe('askSchema videoIds', () => {
  it('accepts the single value multipart actually sends', async () => {
    const { askSchema } = await import('../../src/http/desktop/web-chat.routes');
    const id = '11111111-1111-4111-8111-111111111111';
    // `append-field` stores one occurrence as a string and only builds an array
    // from the second, so the ordinary one-video ask arrives unwrapped.
    const one = askSchema.safeParse({ threadId: 'web_thread1234', text: 'hi', videoIds: id });
    assert.equal(one.success, true);
    assert.deepEqual(one.success && one.data.videoIds, [id]);

    const two = askSchema.safeParse({ threadId: 'web_thread1234', text: 'hi', videoIds: [id, id] });
    assert.equal(two.success, true);

    const junk = askSchema.safeParse({ threadId: 'web_thread1234', text: 'hi', videoIds: 'nope' });
    assert.equal(junk.success, false);
  });
});

describe('company disk budget', () => {
  it('refuses a new recording once the workspace is already holding its limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-budget-'));
    const store = new ConversationVideoStore({ rootDir: root, maxBytes: 1_000_000 });
    const service = new ConversationVideoService({
      store,
      logger: noopLogger,
      maxCompanyBytes: 32,
      // Never settles, so nothing is read and nothing is deleted — which is
      // exactly the state the budget exists to bound.
      understanding: { understand: () => new Promise(() => {}) } as never,
    });

    const accept = (name: string) => service.accept({
      owner,
      fileName: name,
      mimeType: 'video/mp4',
      body: Readable.from([Buffer.alloc(64)]),
    });

    await accept('one.mp4');
    await assert.rejects(
      accept('two.mp4'),
      (error: unknown) => error instanceof ConversationVideoError
        && error.code === 'video_budget_reached',
    );

    // The other tenant is unaffected: the budget is counted per company.
    const other = await service.accept({
      owner: { ...owner, companyId: 'company-2' },
      fileName: 'theirs.mp4',
      mimeType: 'video/mp4',
      body: Readable.from([Buffer.alloc(8)]),
    });
    assert.equal(other.sizeBytes, 8);
    await rm(root, { recursive: true, force: true });
  });
});

describe('company budget under concurrency', () => {
  it('counts uploads that are still streaming, not only what is on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-race-'));
    const store = new ConversationVideoStore({ rootDir: root, maxBytes: 64 });
    const service = new ConversationVideoService({
      store,
      logger: noopLogger,
      maxCompanyBytes: 64,
      understanding: { understand: () => new Promise(() => {}) } as never,
    });

    /* Both start before either has written a byte. Checking the disk alone,
       both see zero and both pass — which is how thirty concurrent uploads get
       through an eight-gigabyte ceiling. */
    const results = await Promise.allSettled([1, 2].map(index => service.accept({
      owner,
      fileName: `race-${index}.mp4`,
      mimeType: 'video/mp4',
      body: Readable.from([Buffer.alloc(8)]),
    })));

    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const refused = results.find(result => result.status === 'rejected');
    assert.ok(refused && refused.status === 'rejected');
    assert.equal((refused.reason as ConversationVideoError).code, 'video_budget_reached');
    await rm(root, { recursive: true, force: true });
  });
});

describe('read-rate cap', () => {
  it('refuses a workspace that keeps starting readings, however small', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-rate-'));
    let reads = 0;
    const service = new ConversationVideoService({
      store: new ConversationVideoStore({ rootDir: root, maxBytes: 1_000_000 }),
      logger: noopLogger,
      maxReadsPerWindow: 2,
      understanding: {
        understand: async () => { reads += 1; return understanding; },
      } as never,
    });

    const send = (name: string) => service.accept({
      owner,
      fileName: name,
      mimeType: 'video/mp4',
      // Tiny, so the byte budget could never be what stops this.
      body: Readable.from([Buffer.alloc(4)]),
    });

    const first = await send('a.mp4');
    const second = await send('b.mp4');
    await assert.rejects(
      send('c.mp4'),
      (error: unknown) => error instanceof ConversationVideoError
        && error.code === 'video_budget_reached',
    );
    // Awaited so the two admitted readings have actually run: `accept` returns
    // as soon as the bytes land and leaves reading to itself.
    await service.understandingFor({ owner, videoId: first.videoId });
    await service.understandingFor({ owner, videoId: second.videoId });
    assert.equal(reads, 2, 'a refused upload must not have started a reading');
    await rm(root, { recursive: true, force: true });
  });
});

describe('read-rate accounting', () => {
  it('does not spend a token on an upload that never starts a reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-token-'));
    const service = new ConversationVideoService({
      // Small enough that the first body is refused mid-stream.
      store: new ConversationVideoStore({ rootDir: root, maxBytes: 4 }),
      logger: noopLogger,
      maxReadsPerWindow: 2,
      understanding: { understand: async () => understanding } as never,
    });

    const send = (name: string, bytes: number) => service.accept({
      owner,
      fileName: name,
      mimeType: 'video/mp4',
      body: Readable.from([Buffer.alloc(bytes)]),
    });

    // Refused for being too large — no reading started, so no token spent.
    await assert.rejects(send('too-big.mp4', 64), ConversationVideoTooLargeError);

    /* Both of these must still be admitted. Counting attempts rather than
       readings would lock a workspace out for an hour on retries that did no
       work — exactly when it is already struggling. */
    await send('a.mp4', 2);
    await send('b.mp4', 2);
    await rm(root, { recursive: true, force: true });
  });
});

describe('read-rate cap under concurrency', () => {
  it('admits only the cap when a whole burst arrives at once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-burst-'));
    const service = new ConversationVideoService({
      store: new ConversationVideoStore({ rootDir: root, maxBytes: 1_000_000 }),
      logger: noopLogger,
      maxReadsPerWindow: 2,
      // No byte budget, so the rate cap is the only thing standing here.
      understanding: { understand: () => new Promise(() => {}) } as never,
    });

    /* All five evaluate the cap before any has written a byte. Checking now and
       spending after the upload finished let every one of them through. */
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(index => service.accept({
      owner,
      fileName: `burst-${index}.mp4`,
      mimeType: 'video/mp4',
      body: Readable.from([Buffer.alloc(4)]),
    })));

    assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
    await rm(root, { recursive: true, force: true });
  });
});

describe('deployment-wide ceiling', () => {
  it('refuses a second tenant once the whole deployment is at its limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-total-'));
    const service = new ConversationVideoService({
      store: new ConversationVideoStore({ rootDir: root, maxBytes: 32 }),
      logger: noopLogger,
      // No per-company budget: this asserts the global ceiling on its own, which
      // is what stops "8 GB each" becoming 8 GB times however many tenants.
      maxTotalBytes: 32,
      understanding: { understand: () => new Promise(() => {}) } as never,
    });

    await service.accept({
      owner,
      fileName: 'ours.mp4',
      mimeType: 'video/mp4',
      body: Readable.from([Buffer.alloc(32)]),
    });
    await assert.rejects(
      service.accept({
        owner: { ...owner, companyId: 'company-2' },
        fileName: 'theirs.mp4',
        mimeType: 'video/mp4',
        body: Readable.from([Buffer.alloc(8)]),
      }),
      (error: unknown) => error instanceof ConversationVideoError
        && error.code === 'video_budget_reached',
    );
    await rm(root, { recursive: true, force: true });
  });
});

describe('budget sizing', () => {
  it('reserves what an upload says it weighs, not the ceiling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'divo-conv-video-size-'));
    const service = new ConversationVideoService({
      // A 2 MB per-request cap with a 6 MB workspace budget. Reserving the cap
      // for every upload would admit three; reserving the real size admits far
      // more, which is the difference between a byte budget and a slot limit.
      store: new ConversationVideoStore({ rootDir: root, maxBytes: 2_000_000 }),
      logger: noopLogger,
      maxCompanyBytes: 6_000_000,
      understanding: { understand: () => new Promise(() => {}) } as never,
    });

    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5, 6, 7, 8].map(index => service.accept({
        owner,
        fileName: `clip-${index}.mp4`,
        mimeType: 'video/mp4',
        declaredBytes: 1_024,
        body: Readable.from([Buffer.alloc(1_024)]),
      })),
    );

    assert.equal(results.filter(result => result.status === 'fulfilled').length, 8);
    await rm(root, { recursive: true, force: true });
  });
});
