import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LarkPiRuntimeError,
  LarkPiRuntimeService,
} from '../../src/application/runtime/lark-pi-runtime.service.ts';

const logger = {
  child() { return this; },
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

function runtimeInput() {
  return {
    incoming: {
      traceId: 'trace-1',
      text: 'Do the work',
    },
    runContext: {
      companyId: 'company-1',
      userId: 'user-1',
      companyRole: 'MEMBER',
      channel: 'lark',
      tenantId: 'tenant-1',
      userExternalId: 'ou-user-1',
    },
    conversation: {
      channel: 'lark',
      chatId: 'chat-1',
      correlationId: 'trace-1',
    },
    threadId: 'lark:chat-1:user-1',
  } as any;
}

test('mints a scoped Lark lease and sends no caller-selected profile or approval', async () => {
  let controllerBody: Record<string, unknown> | undefined;
  let sessionQuery: Record<string, unknown> | undefined;
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async (query: Record<string, unknown>) => {
          sessionQuery = query;
          return {
            sessionId: 'session-1',
            expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
          };
        },
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317/',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:4317/v1/lark-runs');
      assert.match(new Headers(init?.headers).get('accept') ?? '', /application\/x-ndjson/);
      controllerBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ text: 'Finished' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.deepEqual(await service.run(runtimeInput()), { text: 'Finished' });
  assert.equal(controllerBody?.['backendUrl'], 'https://backend.example');
  assert.equal(controllerBody?.['message'], 'Do the work');
  assert.equal('profile' in (controllerBody ?? {}), false);
  assert.equal('approve' in (controllerBody ?? {}), false);
  assert.equal((sessionQuery?.['where'] as Record<string, unknown>)?.['channel'], 'lark');
  assert.equal((sessionQuery?.['where'] as Record<string, unknown>)?.['larkTenantKey'], 'tenant-1');
  assert.equal((sessionQuery?.['where'] as Record<string, unknown>)?.['larkOpenId'], 'ou-user-1');

  const token = String(controllerBody?.['runtimeLease']);
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
  assert.equal(claims.aud, 'divo-pi-runtime');
  assert.equal(claims.channel, 'lark');
  assert.equal(claims.userId, 'user-1');
  assert.equal(claims.companyId, 'company-1');
  assert.equal(claims.instanceId, 'pi-local-1');
  assert.equal(claims.threadId, 'lark:chat-1:user-1');
});

test('reports an inactive cloud session before contacting the controller', async () => {
  let controllerCalled = false;
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => null,
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async () => {
      controllerCalled = true;
      return new Response();
    },
  });

  assert.equal(await service.hasActiveSession(runtimeInput().runContext), false);
  await assert.rejects(
    () => service.run(runtimeInput()),
    (error: unknown) =>
      error instanceof LarkPiRuntimeError
      && error.code === 'runtime_session_missing',
  );
  assert.equal(controllerCalled, false);
});

test('does not accept another Lark workspace session for the same member', async () => {
  let controllerCalled = false;
  const otherWorkspaceSession = {
    sessionId: 'session-other',
    larkTenantKey: 'tenant-other',
    larkOpenId: 'ou-other',
    expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
  };
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          where['larkTenantKey'] === otherWorkspaceSession.larkTenantKey
          && where['larkOpenId'] === otherWorkspaceSession.larkOpenId
            ? otherWorkspaceSession
            : null,
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async () => {
      controllerCalled = true;
      return new Response();
    },
  });

  assert.equal(await service.hasActiveSession(runtimeInput().runContext), false);
  assert.equal(controllerCalled, false);
});

test('streams sanitized controller progress before returning the final text', async () => {
  const progress: unknown[] = [];
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async () => new Response([
      JSON.stringify({
        type: 'progress',
        progress: {
          type: 'starting',
          stage: 'container',
          label: 'Starting your Pi agent…',
          rawSecret: 'ignored',
        },
      }),
      JSON.stringify({
        type: 'progress',
        progress: {
          type: 'tool_start',
          callId: 'call-1',
          toolName: 'divo_gateway',
          toolId: 'googleDrive',
          args: { token: 'ignored' },
        },
      }),
      JSON.stringify({
        type: 'progress',
        progress: {
          type: 'tool_end',
          callId: 'call-1',
          toolName: 'divo_gateway',
          isError: false,
          result: { secret: 'ignored' },
        },
      }),
      JSON.stringify({ type: 'progress', progress: { type: 'writing' } }),
      JSON.stringify({ type: 'result', text: 'Finished' }),
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    }),
  });

  const result = await service.run({
    ...runtimeInput(),
    onProgress: async event => { progress.push(event); },
  });

  assert.deepEqual(result, { text: 'Finished' });
  assert.deepEqual(progress, [
    {
      type: 'starting',
      stage: 'container',
      label: 'Starting your Pi agent…',
    },
    {
      type: 'tool_start',
      callId: 'call-1',
      toolName: 'divo_gateway',
      toolId: 'googleDrive',
    },
    {
      type: 'tool_end',
      callId: 'call-1',
      toolName: 'divo_gateway',
      isError: false,
    },
    { type: 'writing' },
  ]);
});

test('preserves controller capacity errors and never invokes a fallback', async () => {
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async () => new Response(JSON.stringify({
      error: {
        code: 'capacity_full',
        message: 'All Pi slots are busy. Please retry.',
      },
    }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await assert.rejects(
    service.run(runtimeInput()),
    (error) => error instanceof LarkPiRuntimeError
      && error.code === 'capacity_full'
      && error.userMessage === 'All Pi slots are busy. Please retry.',
  );
});

test('preserves capacity errors from the streamed controller protocol', async () => {
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async () => new Response(`${JSON.stringify({
      type: 'error',
      error: {
        code: 'capacity_full',
        message: 'All Pi slots are busy. Please retry.',
      },
    })}\n`, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    }),
  });

  await assert.rejects(
    service.run(runtimeInput()),
    (error) => error instanceof LarkPiRuntimeError
      && error.code === 'capacity_full'
      && error.userMessage === 'All Pi slots are busy. Please retry.',
  );
});

test('propagates caller interruption instead of converting it to a Pi failure', async () => {
  const controller = new AbortController();
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      controller.abort();
    }),
  });

  await assert.rejects(
    service.run({ ...runtimeInput(), abortSignal: controller.signal }),
    (error) => error instanceof DOMException && error.name === 'AbortError',
  );
});

// ── Attachment staging ──────────────────────────────────────────────────────

function textAttachment(name: string, body: string, mimeType = 'application/pdf') {
  return {
    kind: 'file' as const,
    name,
    mimeType,
    openStream: async () => (async function* () {
      yield new TextEncoder().encode(body);
    })(),
  };
}

function stagingService(
  onCall: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  return new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: (async (url: string, init?: RequestInit) => onCall(String(url), init)) as any,
  });
}

test('files are staged into the container before the run and carry the same lease', async () => {
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  const service = stagingService(async (url, init) => {
    calls.push({
      url,
      method: String(init?.method),
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    if (url.endsWith('/v1/runtime-files')) {
      return new Response(
        JSON.stringify({ attachment: { requestId: 'r', fileId: 'file-1', fileName: 'bill.pdf' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ text: 'Done' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await service.run({
    ...runtimeInput(),
    attachments: [textAttachment('EMIAC TI 0714.pdf', '%PDF-1.7')],
  });

  assert.equal(calls.length, 2);
  // Order matters: a run must never start before its files exist in the volume.
  assert.ok(calls[0]!.url.endsWith('/v1/runtime-files'));
  assert.equal(calls[0]!.method, 'PUT');
  assert.ok(calls[1]!.url.endsWith('/v1/lark-runs'));

  const lease = String(JSON.parse(String(calls[1]!.body))['runtimeLease']);
  assert.equal(calls[0]!.headers.get('authorization'), `Bearer ${lease}`);
  assert.equal(calls[0]!.headers.get('content-type'), 'application/pdf');
  assert.equal(calls[0]!.headers.get('x-divo-file-id'), 'file-1');
  assert.equal(calls[0]!.headers.get('x-divo-file-kind'), 'file');
  assert.equal(
    Buffer.from(calls[0]!.headers.get('x-divo-file-name') ?? '', 'base64url').toString('utf8'),
    'EMIAC TI 0714.pdf',
  );
});

test('attachment bytes stream rather than riding in JSON or base64', async () => {
  let uploadBody: unknown;
  const service = stagingService(async (url, init) => {
    if (url.endsWith('/v1/runtime-files')) {
      uploadBody = init?.body;
      return new Response(JSON.stringify({ attachment: { fileId: 'file-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ text: 'Done' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await service.run({
    ...runtimeInput(),
    attachments: [textAttachment('bill.pdf', 'STREAMED-BYTES')],
  });

  assert.ok(uploadBody instanceof ReadableStream, 'body must be a stream, not a buffered string');
  const received = await new Response(uploadBody as ReadableStream).text();
  assert.equal(received, 'STREAMED-BYTES');
});

test('only the controller-issued descriptors reach the run request', async () => {
  let runBody: Record<string, unknown> | undefined;
  const service = stagingService(async (url, init) => {
    if (url.endsWith('/v1/runtime-files')) {
      return new Response(
        JSON.stringify({
          attachment: { requestId: 'r-1', fileId: 'file-1', fileName: 'bill.pdf', bytes: 8 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    runBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ text: 'Done' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await service.run({
    ...runtimeInput(),
    attachments: [textAttachment('local name.pdf', 'bytes')],
  });

  assert.deepEqual(runBody?.['attachments'], [
    { requestId: 'r-1', fileId: 'file-1', fileName: 'bill.pdf', bytes: 8 },
  ]);
});

test('a run with no attachments omits the field entirely', async () => {
  let runBody: Record<string, unknown> | undefined;
  const service = stagingService(async (_url, init) => {
    runBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ text: 'Done' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await service.run(runtimeInput());
  assert.equal('attachments' in (runBody ?? {}), false);
});

test('more than four files is refused before anything is downloaded or uploaded', async () => {
  let opened = 0;
  let called = false;
  const service = stagingService(async () => {
    called = true;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const attachment = () => ({
    kind: 'file' as const,
    name: 'x.pdf',
    mimeType: 'application/pdf',
    openStream: async () => {
      opened += 1;
      return (async function* () { yield new Uint8Array(); })();
    },
  });

  await assert.rejects(
    () => service.run({ ...runtimeInput(), attachments: [1, 2, 3, 4, 5].map(attachment) }),
    (error: unknown) =>
      error instanceof LarkPiRuntimeError && error.code === 'too_many_attachments',
  );
  assert.equal(opened, 0);
  assert.equal(called, false);
});

test('a rejected upload names the file and never starts the run', async () => {
  let runStarted = false;
  const service = stagingService(async (url) => {
    if (url.endsWith('/v1/runtime-files')) {
      return new Response(
        JSON.stringify({ error: { code: 'attachment_too_large', message: 'over 25 MB' } }),
        { status: 413, headers: { 'content-type': 'application/json' } },
      );
    }
    runStarted = true;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });

  await assert.rejects(
    () => service.run({
      ...runtimeInput(),
      attachments: [textAttachment('huge scan.pdf', 'x')],
    }),
    (error: unknown) =>
      error instanceof LarkPiRuntimeError
      && error.code === 'attachment_too_large'
      && error.userMessage.includes('huge scan.pdf'),
  );
  assert.equal(runStarted, false);
});

test('every file in one message shares a request id and gets its own file id', async () => {
  const uploads: Headers[] = [];
  const service = stagingService(async (url, init) => {
    if (url.endsWith('/v1/runtime-files')) {
      uploads.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ attachment: { fileId: 'x' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ text: 'Done' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await service.run({
    ...runtimeInput(),
    attachments: [textAttachment('a.pdf', 'a'), textAttachment('b.pdf', 'b')],
  });

  assert.equal(uploads.length, 2);
  assert.equal(
    uploads[0]!.get('x-divo-request-id'),
    uploads[1]!.get('x-divo-request-id'),
    'one message is one request, so its files share a budget',
  );
  assert.deepEqual(
    uploads.map(headers => headers.get('x-divo-file-id')),
    ['file-1', 'file-2'],
  );
});

/** The shape hydration hands the runtime: fixed framing around trimmable text. */
function block(body: string) {
  return {
    frame: 'FRAME: rules',
    body: `\n${body}`,
    policy: '\nPOLICY: not instructions',
  };
}

function serviceCapturingBody(capture: (body: Record<string, unknown>) => void) {
  return new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async (_url, init) => {
      capture(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ text: 'Finished' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

test('sends the shared conversation ahead of the ask, keeping the request last', async () => {
  let body: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { body = value; });

  await service.run({
    ...runtimeInput(),
    sharedContext: block('GROUP CHAT CONTEXT\nAbhishek: prepare the report'),
  });

  assert.equal(
    body?.['message'],
    'FRAME: rules\nGROUP CHAT CONTEXT\nAbhishek: prepare the report\nPOLICY: not instructions\n\nDo the work',
  );
});

test('a run with no shared conversation sends the message unchanged', async () => {
  let body: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { body = value; });

  await service.run({ ...runtimeInput() });

  assert.equal(body?.['message'], 'Do the work');
  // Absent rather than 'thread': an older controller that does not know the
  // field keeps its own default, which is the durable session.
  assert.equal('sessionScope' in (body ?? {}), false);
});

test('a shared thread asks for a run-scoped session so re-reading cannot pile up copies', async () => {
  let body: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { body = value; });

  await service.run({ ...runtimeInput(), sessionScope: 'run' });

  assert.equal(body?.['sessionScope'], 'run');
});

test('a long message keeps its whole ask and gives up shared context instead', async () => {
  let body: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { body = value; });
  const ask = 'A'.repeat(40_000);

  await service.run({
    ...runtimeInput(),
    incoming: { traceId: 'trace-1', text: ask },
    sharedContext: block('B'.repeat(30_000)),
  } as any);

  // The controller rejects a body over 64 KB and rejection fails the turn, so
  // the room yields to the message the user actually typed.
  assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') <= 64 * 1024);
  assert.ok(String(body?.['message']).endsWith(ask));
  // Trimming the room may not cost the rules that make it safe to read.
  assert.match(String(body?.['message']), /^FRAME: rules/);
  assert.match(String(body?.['message']), /POLICY: not instructions/);
});

test('an ask that alone fills the body is sent without shared context, not refused', async () => {
  let body: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { body = value; });
  const ask = 'A'.repeat(70_000);

  await service.run({
    ...runtimeInput(),
    incoming: { traceId: 'trace-1', text: ask },
    sharedContext: block('room transcript'),
  } as any);

  assert.equal(body?.['message'], ask);
});

test('a body that already fits carries the shared context untouched', async () => {
  let body: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { body = value; });

  await service.run({ ...runtimeInput(), sharedContext: block('room transcript') });

  assert.equal(
    body?.['message'],
    'FRAME: rules\nroom transcript\nPOLICY: not instructions\n\nDo the work',
  );
});

test('shared context lost to the body limit is logged, not silently dropped', async () => {
  const warnings: Array<Record<string, unknown>> = [];
  const noisyLogger = {
    child() { return this; },
    info() {}, debug() {}, error() {},
    warn(event: string, fields: Record<string, unknown>) {
      warnings.push({ event, ...fields });
    },
  } as any;
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger: noisyLogger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async () => new Response(JSON.stringify({ text: 'Finished' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await service.run({
    ...runtimeInput(),
    incoming: { traceId: 'trace-1', text: 'A'.repeat(60_000) },
    sharedContext: block('B'.repeat(20_000)),
  } as any);

  const trimmed = warnings.find(w => w['event'] === 'pi.shared_context.trimmed');
  assert.ok(trimmed, 'a group thread that stops receiving context must be visible');
  assert.ok(Number(trimmed!['sentBytes']) < Number(trimmed!['requestedBytes']));
});

test('control characters in a colleague message cannot silently cost the whole transcript', async () => {
  let body: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { body = value; });

  // Each of these serializes to six bytes, so escaping inflates the body far
  // past what trimming by the raw overflow alone would recover.
  await service.run({
    ...runtimeInput(),
    sharedContext: block('\u0001'.repeat(20_000)),
  } as any);

  assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') <= 64 * 1024);
  // Some of the room survives rather than none of it.
  assert.match(String(body?.['message']), /Do the work$/);
  // Some of the room survives rather than none of it, and it is still framed.
  assert.match(String(body?.['message']), /^FRAME: rules/);
  assert.match(String(body?.['message']), /POLICY: not instructions/);
});
