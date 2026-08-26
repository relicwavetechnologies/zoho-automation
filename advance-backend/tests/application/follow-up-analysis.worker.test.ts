import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FollowUpAnalysisWorker } from '../../src/application/follow-ups/follow-up-analysis.worker.ts';
import { ok } from '../../src/shared/result.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child() { return this; },
} as any;

const candidate = {
  chatId: 'chat-1', companyId: 'company-1', departmentId: 'dept-ua',
  chatName: 'Venue — Taj', isGroup: true,
  lastMessageAt: new Date('2026-08-25T09:00:00Z'),
};

const message = (body: string, fromMe = false) => ({
  senderName: fromMe ? 'Us' : 'Priya', fromMe, body,
  type: 'text', quotedText: null, occurredAt: new Date('2026-08-25T08:00:00Z'),
});

function makeRepo(over: Record<string, unknown> = {}) {
  return {
    marked: [] as any[],
    applied: [] as any[],
    async claimChatsForAnalysis() { return ok([candidate]); },
    async transcriptFor() { return ok([message('Can you confirm the venue?'), message('Yes', true)]); },
    async trackedFor() { return ok([]); },
    async applyPlan(input: any) { this.applied.push(input); return ok(undefined); },
    async markAnalyzed(input: any) { this.marked.push(input); return ok(undefined); },
    async listOpen() { return ok([]); },
    ...over,
  } as any;
}

// A model stub at the `ai` LanguageModel seam is awkward; the worker's model
// call is exercised through its failure path here and through
// follow-up-reconcile.test.ts for the logic. What this file pins is the
// worker's *coordination*, which is where the real risk sits.
const failingModel = {} as any;

describe('FollowUpAnalysisWorker', () => {
  it('stamps an EMPTY window without calling the model', async () => {
    const repo = makeRepo({ async transcriptFor() { return ok([]); } });
    const worker = new FollowUpAnalysisWorker({ repo, model: failingModel, logger: noopLogger });
    await worker.runOnce();

    // Without this stamp the chat stays permanently due and crowds out real work.
    assert.equal(repo.marked.length, 1);
    assert.equal(repo.marked[0].chatId, 'chat-1');
    assert.equal(repo.applied.length, 0, 'no model call, no writes');
  });

  it('DOES analyse a chat holding a single inbound message', async () => {
    // The regression that matters. One "can you send the quote?" with no reply
    // is the purest follow-up there is; the old floor of two messages stamped it
    // as read, and since the chat never moved again it was never looked at.
    const repo = makeRepo({
      async transcriptFor() { return ok([message('Can you send the quote?')]); },
    });
    const worker = new FollowUpAnalysisWorker({ repo, model: failingModel, logger: noopLogger });
    await worker.runOnce();

    // It reached the model (which fails in this stub) rather than being skipped,
    // so nothing was stamped and the next sweep will retry it.
    assert.equal(repo.marked.length, 0, 'not skipped as too short');
  });

  it('DOES analyse a window holding only our own messages', async () => {
    // The other direction: "I'll send it tomorrow" is a commitment we owe.
    const repo = makeRepo({
      async transcriptFor() { return ok([message("I'll send it tomorrow", true)]); },
    });
    const worker = new FollowUpAnalysisWorker({ repo, model: failingModel, logger: noopLogger });
    await worker.runOnce();
    assert.equal(repo.marked.length, 0, 'not skipped as one-sided');
  });

  it('does NOT stamp a chat when the model failed', async () => {
    // A model failure says nothing about the chat. Stamping would skip a real
    // conversation until its next message — which for a stalled thread is never,
    // and a stalled thread is exactly what a follow-up tracker is for.
    const repo = makeRepo();
    const worker = new FollowUpAnalysisWorker({ repo, model: failingModel, logger: noopLogger });
    await worker.runOnce();

    assert.equal(repo.applied.length, 0);
    assert.equal(repo.marked.length, 0, 'left due, so the next sweep retries it');
  });

  it('survives a repository failure without throwing', async () => {
    const repo = makeRepo({
      async claimChatsForAnalysis() {
        return { ok: false, error: { message: 'db down' } } as any;
      },
    });
    const worker = new FollowUpAnalysisWorker({ repo, model: failingModel, logger: noopLogger });
    await assert.doesNotReject(() => worker.runOnce());
  });

  it('does not run two sweeps at once', async () => {
    let claims = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const repo = makeRepo({
      async claimChatsForAnalysis() { claims += 1; await gate; return ok([]); },
    });
    const worker = new FollowUpAnalysisWorker({ repo, model: failingModel, logger: noopLogger });

    const first = worker.runOnce();
    const second = worker.runOnce();   // must be a no-op while the first is live
    release();
    await Promise.all([first, second]);

    assert.equal(claims, 1, 'the second call returned immediately');
  });
});
