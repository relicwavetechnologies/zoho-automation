import assert from 'node:assert/strict';

import { executionService } from '../src/company/observability';
import { __test__ } from '../src/modules/desktop-chat/vercel-desktop.engine';

class MockResponse {
  chunks: string[] = [];

  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }

  toString() {
    return this.chunks.join('');
  }
}

async function run(): Promise<void> {
  const resWithSequence = new MockResponse();
  __test__.sendSseEvent(
    resWithSequence as any,
    'plan',
    { executionId: 'exec_1', value: 'x' },
    7,
  );
  assert.equal(
    resWithSequence.toString(),
    'id: exec_1:7\nevent: plan\ndata: {"type":"plan","data":{"executionId":"exec_1","value":"x"}}\n\n',
  );

  const resWithoutSequence = new MockResponse();
  __test__.sendSseEvent(
    resWithoutSequence as any,
    'done',
    { executionId: 'exec_1', value: 'y' },
  );
  assert.equal(
    resWithoutSequence.toString(),
    'event: done\ndata: {"type":"done","data":{"executionId":"exec_1","value":"y"}}\n\n',
  );

  const originalListRunEvents = executionService.listRunEvents.bind(executionService);
  (executionService as any).listRunEvents = async () => ({
    items: [
      {
        id: 'e1',
        executionId: 'exec_1',
        sequence: 2,
        phase: 'request',
        eventType: 'execution.started',
        actorType: 'system',
        actorKey: 'vercel',
        title: 'started',
        summary: null,
        status: 'running',
        payload: { step: 2 },
        createdAt: new Date().toISOString(),
      },
      {
        id: 'e2',
        executionId: 'exec_1',
        sequence: 4,
        phase: 'tool',
        eventType: 'tool.completed',
        actorType: 'tool',
        actorKey: 'x',
        title: 'done',
        summary: null,
        status: 'done',
        payload: { step: 4 },
        createdAt: new Date().toISOString(),
      },
      {
        id: 'e3',
        executionId: 'exec_1',
        sequence: 3,
        phase: 'tool',
        eventType: 'tool.started',
        actorType: 'tool',
        actorKey: 'x',
        title: 'started',
        summary: null,
        status: 'running',
        payload: { step: 3 },
        createdAt: new Date().toISOString(),
      },
    ],
  });

  const replayRes = new MockResponse();
  await __test__.replayMissedSseEvents({
    req: { headers: { 'last-event-id': 'exec_1:2' } } as any,
    res: replayRes as any,
    executionId: 'exec_1',
    session: { companyId: 'company_1', userId: 'user_1' } as any,
  });
  assert.equal(
    replayRes.toString(),
    'id: exec_1:3\nevent: tool.started\ndata: {"type":"tool.started","data":{"step":3,"executionId":"exec_1"}}\n\nid: exec_1:4\nevent: tool.completed\ndata: {"type":"tool.completed","data":{"step":4,"executionId":"exec_1"}}\n\n',
  );

  const noReplayRes = new MockResponse();
  await __test__.replayMissedSseEvents({
    req: { headers: { 'last-event-id': 'malformed' } } as any,
    res: noReplayRes as any,
    executionId: 'exec_1',
    session: { companyId: 'company_1', userId: 'user_1' } as any,
  });
  assert.equal(noReplayRes.toString(), '');

  (executionService as any).listRunEvents = originalListRunEvents;
  console.log('sse-reconnect-harness-ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
