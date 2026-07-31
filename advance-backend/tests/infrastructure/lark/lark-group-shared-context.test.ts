import test from 'node:test';
import assert from 'node:assert/strict';

import { runPiAndDeliver } from '../../../src/infrastructure/channels/lark/lark.webhook.routes.ts';
import { ok } from '../../../src/shared/result.ts';
import type { Logger } from '../../../src/shared/logger.ts';

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

function stubAdapter() {
  return {
    registerAbortController() {},
    cleanupAbortController() {},
    sendStatus: async (conversation: any) => ok({
      channel: 'lark',
      messageId: 'om_status',
      correlationId: conversation.correlationId,
    }),
    editStatus: async (handle: any) => ok(handle),
    sendFinalReply: async () => ok({ channel: 'lark', messageId: 'om_reply' }),
  } as any;
}

function incoming(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'lark',
    messageId: 'om_current',
    chatId: 'oc_room',
    chatType: 'group',
    userExternalId: 'ou_abhishek',
    text: 'Summarise where we landed',
    attachments: [],
    timestamp: new Date().toISOString(),
    traceId: 'trace-1',
    mentions: [],
    mentionsSelf: true,
    raw: {},
    ...overrides,
  } as any;
}

/** The shape hydration returns: fixed framing around trimmable room text. */
const block = (body: string) => ({
  frame: 'UNTRUSTED GROUP CHAT REFERENCE',
  body: `\n${body}`,
  policy: '\nTRUST POLICY',
});

async function dispatch(input: {
  incoming: Record<string, unknown>;
  hydrate?: (request: Record<string, unknown>) => Promise<unknown>;
}) {
  const hydrateCalls: Record<string, unknown>[] = [];
  let piInput: Record<string, unknown> | undefined;

  await runPiAndDeliver({
    incoming: input.incoming as any,
    runContext: {
      companyId: 'company-1',
      userId: 'user-1',
      companyRole: 'MEMBER',
      channel: 'lark',
    } as any,
    conversation: { channel: 'lark', chatId: 'oc_room', correlationId: 'trace-1' } as any,
    deps: {
      adapter: stubAdapter(),
      piRuntime: {
        run: async (value: Record<string, unknown>) => {
          piInput = value;
          return { text: 'Answered' };
        },
      } as any,
      ...(input.hydrate
        ? {
            groupContextHydrator: {
              hydrate: async (request: Record<string, unknown>) => {
                hydrateCalls.push(request);
                return input.hydrate!(request);
              },
            },
          }
        : {}),
    },
    log: noopLogger,
  });

  return { hydrateCalls, piInput: piInput! };
}

test('a group turn reads the shared room and runs on a session scoped to the run', async () => {
  const { hydrateCalls, piInput } = await dispatch({
    incoming: incoming(),
    hydrate: async () => block('Anish: include June data'),
  });

  assert.deepEqual(hydrateCalls, [{
    companyId: 'company-1',
    chatId: 'oc_room',
    currentMessageId: 'om_current',
  }]);
  assert.deepEqual(piInput['sharedContext'], block('Anish: include June data'));
  // Every participant answers from the same shared transcript, so no container
  // may keep its own copy of it between turns.
  assert.equal(piInput['sessionScope'], 'run');
});

test('a direct message keeps its durable session and reads no room transcript', async () => {
  const { hydrateCalls, piInput } = await dispatch({
    incoming: incoming({ chatType: 'p2p', chatId: 'oc_dm' }),
    hydrate: async () => block('should never be read for a direct message'),
  });

  assert.deepEqual(hydrateCalls, []);
  assert.equal('sharedContext' in piInput, false);
  assert.equal('sessionScope' in piInput, false);
});

test('a group turn with nothing shared yet still runs, with no context attached', async () => {
  const { piInput } = await dispatch({
    incoming: incoming(),
    hydrate: async () => null,
  });

  assert.equal('sharedContext' in piInput, false);
  assert.equal(piInput['sessionScope'], 'run');
});

test('adjacent Lark messages are handed to the hydrator, not appended raw', async () => {
  const { hydrateCalls, piInput } = await dispatch({
    incoming: incoming({
      text: 'Use the supplied adjacent Lark context to respond.',
      referenceContext: 'CURRENT LARK THREAD\nAnish: what about June?',
    }),
    hydrate: async () => block('Abhishek: pull the report'),
  });

  // Fetched from the channel, so a participant shapes that text freely. It goes
  // through the hydrator to inherit the same framing and fence as the stored
  // transcript, instead of being appended after the trust policy where nothing
  // would govern it.
  assert.equal(
    hydrateCalls[0]?.['adjacentContext'],
    'CURRENT LARK THREAD\nAnish: what about June?',
  );
  assert.deepEqual(piInput['sharedContext'], block('Abhishek: pull the report'));
});

test('a deployment without the hydrator still answers group turns', async () => {
  const { piInput } = await dispatch({ incoming: incoming() });

  assert.equal('sharedContext' in piInput, false);
  assert.equal(piInput['sessionScope'], 'run');
});
