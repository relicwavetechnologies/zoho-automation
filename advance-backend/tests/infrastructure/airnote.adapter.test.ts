/**
 * Unit tests for AirnoteChannelAdapter.
 *
 * Covers:
 *   - parseIncoming produces channel:'airnote' IncomingMessage
 *   - emit helpers produce well-formed SSE frames
 *   - sendFinalReply persists DesktopMessage + DesktopThread + emits done
 *   - guarded no-write after writableEnded
 *   - emitToolStart / emitToolEnd / emitTextDelta produce correct frames
 *   - emitTimelineEvents deduplicates plan + thinking
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AirnoteChannelAdapter } from '../../src/infrastructure/channels/desktop/airnote.adapter.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function () { return this; },
} as any;

function makeMockRes(ended = false) {
  const written: string[] = [];
  let isEnded = ended;
  return {
    get writableEnded() { return isEnded; },
    end() { isEnded = true; },
    write(chunk: string) { written.push(chunk); return true; },
    _written: written,
  } as unknown as import('express').Response & { _written: string[] };
}

function parseSseFrames(written: string[]) {
  return written
    .map(chunk => {
      const m = chunk.match(/^event: ([^\n]+)\ndata: (.+)\n\n$/s);
      return m ? { name: m[1]!, data: JSON.parse(m[2]!) } : null;
    })
    .filter(Boolean) as Array<{ name: string; data: unknown }>;
}

const MOCK_MSG_ID    = 'msg-persisted-1';
const MOCK_THREAD_ID = 'thread-test-1';

function makePrisma() {
  return {
    desktopMessage: {
      create: async () => ({
        id: MOCK_MSG_ID, threadId: MOCK_THREAD_ID, role: 'assistant',
        content: '# Answer', metadata: null, createdAt: new Date(),
      }),
    },
    desktopThread: {
      update: async () => ({}),
    },
  } as any;
}

function makeAdapter(res = makeMockRes(), prisma = makePrisma()) {
  return {
    adapter: new AirnoteChannelAdapter({
      prisma,
      res,
      requestId: 'req-test-1',
      logger: noopLogger,
    }),
    res,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AirnoteChannelAdapter.parseIncoming', () => {
  it('produces channel:airnote IncomingMessage', () => {
    const { adapter } = makeAdapter();
    const result = adapter.parseIncoming({
      requestId:      'req-1',
      threadId:       MOCK_THREAD_ID,
      message:        'What are our top expenses?',
      userExternalId: 'lark-open-id-1',
      timestamp:      '2026-01-01T00:00:00.000Z',
    });

    assert.ok(result.ok);
    assert.equal(result.value.channel, 'airnote');
    assert.equal(result.value.chatType, 'p2p');
    assert.equal(result.value.text, 'What are our top expenses?');
    assert.equal(result.value.userExternalId, 'lark-open-id-1');
    assert.equal(result.value.mentions.length, 0);
    assert.equal(result.value.mentionsSelf, true);
  });

  it('returns err for missing message', () => {
    const { adapter } = makeAdapter();
    const result = adapter.parseIncoming({ requestId: 'r', threadId: 't', userExternalId: 'u', timestamp: 't' });
    assert.ok(!result.ok);
  });

  it('returns err for empty payload', () => {
    const { adapter } = makeAdapter();
    const result = adapter.parseIncoming({});
    assert.ok(!result.ok);
  });
});

describe('AirnoteChannelAdapter SSE emit helpers', () => {
  it('emitToolStart produces tool.start frame', () => {
    const { adapter, res } = makeAdapter();
    adapter.emitToolStart({ callId: 'c1', name: 'zoho_search', family: 'zoho', args: { q: 'test' }, verb: 'Searching' });
    const frames = parseSseFrames((res as any)._written);
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.name, 'tool.start');
    const d = frames[0]!.data as any;
    assert.equal(d.callId, 'c1');
    assert.equal(d.family, 'zoho');
    assert.equal(d.verb, 'Searching');
  });

  it('emitToolEnd produces tool.end frame (no output field)', () => {
    const { adapter, res } = makeAdapter();
    adapter.emitToolEnd({ callId: 'c2', name: 'zoho_search', ok: true, output: 'raw', durationMs: 250, past: 'Searched' });
    const frames = parseSseFrames((res as any)._written);
    assert.equal(frames[0]!.name, 'tool.end');
    const d = frames[0]!.data as any;
    assert.equal(d.ok, true);
    assert.equal(d.durationMs, 250);
    assert.equal(d.past, 'Searched');
    // output should NOT appear in the SSE payload (per plan spec: omit raw output)
    assert.ok(!('output' in d), 'output should not be forwarded to client');
  });

  it('emitTextDelta produces text frame with delta', () => {
    const { adapter, res } = makeAdapter();
    adapter.emitTextDelta('Hello ');
    const frames = parseSseFrames((res as any)._written);
    assert.equal(frames[0]!.name, 'text');
    assert.equal((frames[0]!.data as any).delta, 'Hello ');
  });

  it('emitTextDelta with empty string does not write', () => {
    const { adapter, res } = makeAdapter();
    adapter.emitTextDelta('');
    assert.equal((res as any)._written.length, 0);
  });

  it('emitError produces error frame', () => {
    const { adapter, res } = makeAdapter();
    adapter.emitError('Something went wrong');
    const frames = parseSseFrames((res as any)._written);
    assert.equal(frames[0]!.name, 'error');
    assert.equal((frames[0]!.data as any).message, 'Something went wrong');
  });
});

describe('AirnoteChannelAdapter.sendStatus (timeline → SSE)', () => {
  it('emits status frame from timeline phase + liveLabel', async () => {
    const { adapter, res } = makeAdapter();
    const conv = { channel: 'airnote' as const, chatId: MOCK_THREAD_ID as any, correlationId: 'corr-1' as any };

    await adapter.sendStatus(conv, {
      kind: 'status', terminal: false,
      timeline: { phase: 'executing', liveLabel: 'Fetching data', progressPct: 40 },
    });

    const frames = parseSseFrames((res as any)._written);
    const status = frames.find(f => f.name === 'status');
    assert.ok(status, 'status frame missing');
    assert.equal((status!.data as any).phase, 'executing');
    assert.equal((status!.data as any).liveLabel, 'Fetching data');
    assert.equal((status!.data as any).progressPct, 40);
  });

  it('emits thinking frame from narration', async () => {
    const { adapter, res } = makeAdapter();
    const conv = { channel: 'airnote' as const, chatId: MOCK_THREAD_ID as any, correlationId: 'corr-2' as any };

    await adapter.sendStatus(conv, {
      kind: 'status', terminal: false,
      timeline: { narration: ['Looking up invoices'], narrationActive: 'still going...' },
    });

    const frames = parseSseFrames((res as any)._written);
    const thinking = frames.find(f => f.name === 'thinking');
    assert.ok(thinking, 'thinking frame missing');
    assert.ok((thinking!.data as any).text.includes('Looking up invoices'));
  });

  it('deduplicates plan — same plan emitted only once', async () => {
    const { adapter, res } = makeAdapter();
    const conv = { channel: 'airnote' as const, chatId: MOCK_THREAD_ID as any, correlationId: 'corr-3' as any };
    const plan = [{ status: 'running', title: 'Step 1' }];

    await adapter.sendStatus(conv, { kind: 'status', terminal: false, timeline: { plan } });
    await adapter.sendStatus(conv, { kind: 'status', terminal: false, timeline: { plan } });

    const frames = parseSseFrames((res as any)._written);
    const statusFrames = frames.filter(f => f.name === 'status' && (f.data as any).plan);
    assert.equal(statusFrames.length, 1, 'plan should only be emitted once when unchanged');
  });

  it('deduplicates thinking — same text emitted only once', async () => {
    const { adapter, res } = makeAdapter();
    const conv = { channel: 'airnote' as const, chatId: MOCK_THREAD_ID as any, correlationId: 'corr-4' as any };

    await adapter.sendStatus(conv, { kind: 'status', terminal: false, timeline: { narration: ['Processing...'] } });
    await adapter.sendStatus(conv, { kind: 'status', terminal: false, timeline: { narration: ['Processing...'] } });

    const frames = parseSseFrames((res as any)._written);
    const thinking = frames.filter(f => f.name === 'thinking');
    assert.equal(thinking.length, 1, 'thinking should only be emitted once when text unchanged');
  });
});

describe('AirnoteChannelAdapter.sendFinalReply', () => {
  it('persists DesktopMessage and emits done with message id', async () => {
    const prisma = makePrisma();
    const res = makeMockRes();
    const adapter = new AirnoteChannelAdapter({ prisma, res, requestId: 'req-final', logger: noopLogger });

    const conv = { channel: 'airnote' as const, chatId: MOCK_THREAD_ID as any, correlationId: 'corr-f' as any };
    const result = await adapter.sendFinalReply(conv, {
      kind: 'final', text: '# Result', format: 'markdown',
    });

    assert.ok(result.ok);
    const frames = parseSseFrames((res as any)._written);
    const done = frames.find(f => f.name === 'done');
    assert.ok(done, 'done frame missing');
    assert.equal((done!.data as any).message.id, MOCK_MSG_ID);
    assert.equal((done!.data as any).message.role, 'assistant');
    assert.equal((done!.data as any).format, 'markdown');
  });

  it('returns err and does not throw when prisma fails', async () => {
    const brokenPrisma = {
      desktopMessage: { create: async () => { throw new Error('DB down'); } },
      desktopThread:  { update: async () => ({}) },
    } as any;
    const res = makeMockRes();
    const adapter = new AirnoteChannelAdapter({ prisma: brokenPrisma, res, requestId: 'req-err', logger: noopLogger });
    const conv = { channel: 'airnote' as const, chatId: MOCK_THREAD_ID as any, correlationId: 'corr-e' as any };

    const result = await adapter.sendFinalReply(conv, { kind: 'final', text: 'hi', format: 'markdown' });
    assert.ok(!result.ok);
    assert.ok(result.error.message.includes('DB down'));
  });
});

describe('AirnoteChannelAdapter guard — no write after writableEnded', () => {
  it('does not write when res.writableEnded is true', () => {
    const res = makeMockRes(true); // already ended
    const adapter = new AirnoteChannelAdapter({ prisma: makePrisma(), res, requestId: 'r', logger: noopLogger });
    adapter.emitTextDelta('hello');
    adapter.emitError('boom');
    assert.equal((res as any)._written.length, 0);
  });
});
