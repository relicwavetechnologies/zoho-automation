import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebRunRegistry, WebRunBusyError } from '../../src/application/runtime/web-run-registry';
import type { WebRunEvent } from '../../src/application/runtime/web-run.service';

/**
 * The registry exists to make one sentence true: a run does not belong to the
 * connection that started it. Every test here is a way of leaving and coming
 * back.
 */

const silentLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => silentLogger,
} as never;

function registry() {
  return new WebRunRegistry({ logger: silentLogger });
}

/** A run whose frames are released one at a time, by the test. */
function controlled() {
  const queue: WebRunEvent[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const push = (event: WebRunEvent) => { queue.push(event); wake?.(); wake = undefined; };
  const end = () => { done = true; wake?.(); wake = undefined; };
  const events = (async function* (): AsyncGenerator<WebRunEvent> {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (done) return;
      await new Promise<void>(resolve => { wake = resolve; });
    }
  })();
  return { events, push, end };
}

function timeline(phase: string): WebRunEvent {
  return { type: 'timeline', timeline: { phase } };
}

async function collect(
  source: AsyncGenerator<WebRunEvent>,
  count: number,
): Promise<WebRunEvent[]> {
  const seen: WebRunEvent[] = [];
  for await (const event of source) {
    seen.push(event);
    if (seen.length >= count) break;
  }
  return seen;
}

/** Lets queued microtasks and the drain loop settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('web run registry', () => {
  it('keeps the run going while nobody is watching', async () => {
    const runs = registry();
    const run = controlled();
    runs.start({
      runId: 'r1', threadId: 'web_t1', userId: 'u1', prompt: 'hi',
      controller: new AbortController(), events: run.events,
    });

    // Nothing attached. The run works anyway.
    run.push(timeline('planning'));
    run.push(timeline('working'));
    await settle();

    const handle = runs.find('u1', 'web_t1');
    assert.equal(handle?.settled, false);

    // A reader arriving now is handed where it has got to, not where it began.
    const seen = await collect(runs.attach('u1', 'web_t1'), 1);
    assert.deepEqual(seen[0], timeline('working'));
    run.end();
  });

  it('replays both the latest timeline and live answer to a late reader', async () => {
    const runs = registry();
    const run = controlled();
    runs.start({
      runId: 'r1', threadId: 'web_t1', userId: 'u1', prompt: 'hi',
      controller: new AbortController(), events: run.events,
    });
    run.push(timeline('working'));
    run.push({ type: 'answer_delta', delta: 'Half of ' });
    run.push({ type: 'answer_delta', delta: 'the answer' });
    await settle();

    assert.deepEqual(await collect(runs.attach('u1', 'web_t1'), 2), [
      timeline('working'),
      { type: 'answer', text: 'Half of the answer' },
    ]);
    run.end();
  });

  it('replays the answer to a reader who was away when it landed', async () => {
    const runs = registry();
    const run = controlled();
    runs.start({
      runId: 'r1', threadId: 'web_t1', userId: 'u1', prompt: 'hi',
      controller: new AbortController(), events: run.events,
    });
    run.push({ type: 'final', text: 'Done.', timeline: {} });
    run.end();
    await settle();

    const seen = await collect(runs.attach('u1', 'web_t1'), 1);
    assert.equal(seen[0]?.type, 'final');
    assert.equal(runs.find('u1', 'web_t1')?.settled, true);
  });

  it('feeds two views of the same run the same frames', async () => {
    const runs = registry();
    const run = controlled();
    runs.start({
      runId: 'r1', threadId: 'web_t1', userId: 'u1', prompt: 'hi',
      controller: new AbortController(), events: run.events,
    });

    const first = collect(runs.attach('u1', 'web_t1'), 1);
    const second = collect(runs.attach('u1', 'web_t1'), 1);
    await settle();
    run.push(timeline('working'));

    assert.deepEqual(await first, [timeline('working')]);
    assert.deepEqual(await second, [timeline('working')]);
    run.end();
  });

  it('refuses a second run on a thread that already has one', async () => {
    const runs = registry();
    const run = controlled();
    runs.start({
      runId: 'r1', threadId: 'web_t1', userId: 'u1', prompt: 'hi',
      controller: new AbortController(), events: run.events,
    });
    assert.throws(() => runs.start({
      runId: 'r2', threadId: 'web_t1', userId: 'u1', prompt: 'again',
      controller: new AbortController(), events: controlled().events,
    }), WebRunBusyError);
    run.end();
  });

  it('lets the same thread run again once the first has settled', async () => {
    const runs = registry();
    const first = controlled();
    runs.start({
      runId: 'r1', threadId: 'web_t1', userId: 'u1', prompt: 'hi',
      controller: new AbortController(), events: first.events,
    });
    first.end();
    await settle();

    const second = controlled();
    const handle = runs.start({
      runId: 'r2', threadId: 'web_t1', userId: 'u1', prompt: 'again',
      controller: new AbortController(), events: second.events,
    });
    assert.equal(handle.runId, 'r2');
    second.end();
  });

  it('is reachable only by the member who started it', async () => {
    const runs = registry();
    const run = controlled();
    runs.start({
      runId: 'r1', threadId: 'web_t1', userId: 'u1', prompt: 'hi',
      controller: new AbortController(), events: run.events,
    });

    assert.equal(runs.find('someone-else', 'web_t1'), null);
    assert.equal(runs.stop('someone-else', 'web_t1'), false);
    assert.deepEqual(await collect(runs.attach('someone-else', 'web_t1'), 1), []);
    run.end();
  });

  it('stop aborts the run it was given, and says so', async () => {
    const runs = registry();
    const run = controlled();
    const controller = new AbortController();
    runs.start({
      runId: 'r1', threadId: 'web_t1', userId: 'u1', prompt: 'hi',
      controller, events: run.events,
    });

    assert.equal(runs.stop('u1', 'web_t1'), true);
    assert.equal(controller.signal.aborted, true);
    run.end();
    await settle();
    // Already over: stopping again is not a second abort.
    assert.equal(runs.stop('u1', 'web_t1'), false);
  });

  it('records a run that threw, for whoever attaches next', async () => {
    const runs = registry();
    const events = (async function* (): AsyncGenerator<WebRunEvent> {
      yield timeline('working');
      throw new Error('the runtime fell over');
    })();
    runs.start({
      runId: 'r1', threadId: 'web_t1', userId: 'u1', prompt: 'hi',
      controller: new AbortController(), events,
    });
    await settle();

    const seen = await collect(runs.attach('u1', 'web_t1'), 2);
    assert.equal(seen.at(-1)?.type, 'error');
  });

  it('lists only the runs still going, per member', async () => {
    const runs = registry();
    const going = controlled();
    const over = controlled();
    runs.start({
      runId: 'r1', threadId: 'web_t1', userId: 'u1', prompt: 'a',
      controller: new AbortController(), events: going.events,
    });
    runs.start({
      runId: 'r2', threadId: 'web_t2', userId: 'u1', prompt: 'b',
      controller: new AbortController(), events: over.events,
    });
    over.end();
    await settle();

    assert.deepEqual(runs.activeFor('u1').map(run => run.threadId), ['web_t1']);
    assert.deepEqual(runs.activeFor('u2'), []);
    going.end();
  });
});
