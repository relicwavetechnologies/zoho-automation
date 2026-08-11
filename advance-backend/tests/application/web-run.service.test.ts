import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebRunService, type WebRunEvent } from '../../src/application/runtime/web-run.service.ts';
import { LarkPiRuntimeError } from '../../src/application/runtime/lark-pi-runtime.service.ts';
import type { RunContext } from '../../src/domain/orchestration/run-context.ts';

const noopLogger = {
  child: () => noopLogger,
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
} as never;

const RUN_CONTEXT = {
  companyId: 'company-1',
  userId: 'user-1',
  companyRole: 'MEMBER',
  channel: 'web',
} as unknown as RunContext;

/** Capture what the shared runtime was asked to do, and drive its progress. */
function fakeRuntime(behaviour: {
  readonly onRun?: (input: Record<string, unknown>) => void;
  readonly emit?: (report: (event: never) => void) => Promise<void>;
  readonly result?: Record<string, unknown>;
  readonly fail?: unknown;
}) {
  const seen: Record<string, unknown>[] = [];
  return {
    seen,
    piRuntime: {
      run: async (input: Record<string, unknown>) => {
        seen.push(input);
        behaviour.onRun?.(input);
        const report = input['onProgress'] as ((event: unknown) => void) | undefined;
        await behaviour.emit?.(report as never);
        if (behaviour.fail) throw behaviour.fail;
        return behaviour.result ?? { text: 'Done.' };
      },
    } as never,
  };
}

async function collect(events: AsyncGenerator<WebRunEvent>): Promise<WebRunEvent[]> {
  const out: WebRunEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const ask = {
  runContext: RUN_CONTEXT,
  threadId: 'web:thread-1',
  text: 'How much did we invoice in March?',
  userExternalId: 'user-1',
};

describe('web run', () => {
  // The claim this whole design rests on. If the web ever calls a different
  // runtime, "one soul" is a slogan.
  it('drives the same runtime a Lark message drives, labelled as web', async () => {
    const { piRuntime, seen } = fakeRuntime({});
    const service = new WebRunService({ piRuntime, logger: noopLogger });

    await collect(service.run(ask));

    const input = seen[0]!;
    const incoming = input['incoming'] as Record<string, unknown>;
    assert.equal(incoming['channel'], 'web');
    assert.equal(incoming['text'], ask.text);
    // A private one-to-one turn — the same shape a DM has, so nothing downstream
    // needs a second code path to handle it.
    assert.equal(incoming['chatType'], 'p2p');
    assert.equal(input['threadId'], 'web:thread-1');
  });

// A cold container emits nothing while it boots. Without a frame up front the
  // reader watches an empty stream and cannot tell starting from broken.
  it('acknowledges the run before the runtime has produced anything', async () => {
    const { piRuntime } = fakeRuntime({});
    const service = new WebRunService({ piRuntime, logger: noopLogger });

    const events = await collect(service.run(ask));

    assert.equal(events[0]?.type, 'timeline');
    assert.equal(events[0]?.type === 'timeline' && events[0].timeline.state, 'thinking');
  });

  it('streams the work as it happens and ends with the answer', async () => {
    const { piRuntime } = fakeRuntime({
      emit: async report => {
        report({ type: 'tool_start', callId: 'c1', toolName: 'bash', detail: 'zoho invoices' } as never);
        report({ type: 'tool_end', callId: 'c1', toolName: 'bash', isError: false } as never);
      },
      result: { text: '£48,200 across 31 invoices.' },
    });
    const service = new WebRunService({ piRuntime, logger: noopLogger });

    const events = await collect(service.run(ask));
    const final = events.at(-1)!;

    assert.equal(final.type, 'final');
    assert.equal(final.type === 'final' && final.text, '£48,200 across 31 invoices.');
    // The reader saw the step, not just the answer.
    assert.deepEqual(
      final.type === 'final' ? final.timeline.ledger?.map(r => `${r.label}:${r.status}`) : [],
      ['Terminal:done'],
    );
  });

  // A frame the run produced after it returned would otherwise be dropped by the
  // generator finishing first — and the dropped one is the last, which is the
  // one that says what happened.
  it('does not lose the final frames to the run finishing', async () => {
    const { piRuntime } = fakeRuntime({
      emit: async report => {
        for (let i = 0; i < 5; i += 1) {
          report({ type: 'tool_start', callId: `c${i}`, toolName: 'read' } as never);
        }
      },
    });
    const service = new WebRunService({ piRuntime, logger: noopLogger });

    const events = await collect(service.run(ask));
    const final = events.at(-1)!;

    assert.equal(final.type, 'final');
    assert.equal(final.type === 'final' && final.timeline.actionCount, 5);
  });

  it("reports a runtime failure as the run's own words, not a stack", async () => {
    const { piRuntime } = fakeRuntime({
      fail: new LarkPiRuntimeError('capacity_full', 'Divo is at full capacity right now.'),
    });
    const service = new WebRunService({ piRuntime, logger: noopLogger });

    const events = await collect(service.run(ask));

    assert.deepEqual(events.at(-1), {
      type: 'error',
      code: 'capacity_full',
      message: 'Divo is at full capacity right now.',
    });
  });

  it('hands files to the run rather than staging them somewhere first', async () => {
    const { piRuntime, seen } = fakeRuntime({});
    const service = new WebRunService({ piRuntime, logger: noopLogger });

    await collect(service.run({
      ...ask,
      attachments: [{
        kind: 'file',
        name: 'march.csv',
        mimeType: 'text/csv',
        openStream: async () => (async function* () { yield new Uint8Array([1]); })(),
      }],
    }));

    const attachments = seen[0]!['attachments'] as readonly { name: string }[];
    assert.deepEqual(attachments.map(a => a.name), ['march.csv']);
  });

  it('omits attachments entirely when there are none', async () => {
    const { piRuntime, seen } = fakeRuntime({});
    const service = new WebRunService({ piRuntime, logger: noopLogger });

    await collect(service.run(ask));

    assert.equal('attachments' in seen[0]!, false);
  });

  // Stopping is the reader's, and what they want is to hear that it stopped.
  // The runtime answers "Stopped." on an abort, so the stream must stay open
  // long enough to carry it.
  it("carries the runtime's stopped answer instead of dying with the signal", async () => {
    const controller = new AbortController();
    const { piRuntime } = fakeRuntime({
      emit: async report => {
        report({ type: 'tool_start', callId: 'c1', toolName: 'bash' } as never);
        controller.abort();
      },
      result: { text: 'Stopped. I did not continue this request.' },
    });
    const service = new WebRunService({ piRuntime, logger: noopLogger });

    const events = await collect(service.run({ ...ask, abortSignal: controller.signal }));

    assert.equal(events.at(-1)?.type, 'final');
    assert.match(
      events.at(-1)?.type === 'final' ? events.at(-1)!.text : '',
      /Stopped/,
    );
  });

describe('approvals', () => {
  const pending = (requestedAt: string, status = 'pending') => ({
    id: 'approval-1', toolId: 'zohoBooks', action: 'write', status,
    requestedAt, expiresAt: null, requestedByName: 'you',
    approverName: 'your manager', departmentName: 'Finance',
    deliveredVia: 'web', description: { title: 'Create invoice' }, payload: {},
  });

  const withInbox = (items: unknown[]) => ({
    list: async () => ({ awaitingMe: [], requestedByMe: items }),
  } as never);

  // On Lark the buttons arrive in the same conversation. A reader who has to
  // know to go and look somewhere else has not been asked, they have been filed.
  it('carries what this run asked permission for on the answer itself', async () => {
    const { piRuntime } = fakeRuntime({});
    const service = new WebRunService({
      piRuntime, logger: noopLogger, approvals: withInbox([pending(new Date(Date.now() + 50).toISOString())]),
    });

    const events = await collect(service.run(ask));
    const final = events.at(-1)!;

    assert.equal(final.type === 'final' && final.awaitingApproval?.length, 1);
  });

  // Older pending approvals belong in the inbox, not stapled to an answer the
  // reader is looking at now.
  it('leaves approvals older than this run in the inbox where they belong', async () => {
    const { piRuntime } = fakeRuntime({});
    const service = new WebRunService({
      piRuntime, logger: noopLogger, approvals: withInbox([pending('2020-01-01T00:00:00.000Z')]),
    });

    const events = await collect(service.run(ask));

    assert.equal(events.at(-1)?.type === 'final' && 'awaitingApproval' in events.at(-1)!, false);
  });

  it('still delivers the answer when the approval subsystem is down', async () => {
    const { piRuntime } = fakeRuntime({ result: { text: 'Here you go.' } });
    const service = new WebRunService({
      piRuntime,
      logger: noopLogger,
      approvals: { list: async () => { throw new Error('inbox unavailable'); } } as never,
    });

    const events = await collect(service.run(ask));

    assert.equal(events.at(-1)?.type, 'final');
    assert.equal(events.at(-1)?.type === 'final' ? events.at(-1)!.text : '', 'Here you go.');
  });
});
});
