import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLarkMeetingTool } from '../../src/application/tools/families/lark-meeting.tool.ts';
import { makeAllowedPerm, makeCtx, makeDeniedPerm } from './tool-test.helpers.ts';

const meeting = { id: 'meeting-1', topic: 'Launch review' };
const fakeClient = {
  searchMeetings: async () => [meeting],
  getMeeting: async () => meeting,
  getRecording: async () => ({ id: 'recording-1', url: 'https://example.larksuite.com/recording/1' }),
};

describe('larkMeeting tool', () => {
  const ctx = makeCtx('larkMeeting', ['read']);

  it('is read-only and rejects a missing permission', () => {
    const tool = createLarkMeetingTool({ client: fakeClient });
    const denied = tool.permissionCheck({ op: 'search' }, makeDeniedPerm());
    const allowed = tool.permissionCheck({ op: 'get', meetingId: 'meeting-1' }, makeAllowedPerm('larkMeeting', ['read']));

    assert.equal(denied.ok, false);
    assert.equal(allowed.ok, true);
    assert.equal((allowed as any).value, 'read');
  });

  it('uses the selected Divo-managed user connection for a search', async () => {
    let baseCalled = false;
    let receivedConnectionId: string | undefined;
    const tool = createLarkMeetingTool({
      client: { ...fakeClient, searchMeetings: async () => { baseCalled = true; return []; } },
      userTokenResolver: {
        resolve: async (input) => {
          receivedConnectionId = input.connectionId;
          assert.equal(input.minimumAccess, 'read_only');
          return 'user-token';
        },
      },
      createUserClient: (token) => {
        assert.equal(token, 'user-token');
        return fakeClient;
      },
    });

    const result = await tool.execute({ op: 'search', query: 'launch', connectionId: '11111111-1111-4111-8111-111111111111' }, ctx);
    assert.equal(result.ok, true);
    assert.equal(receivedConnectionId, '11111111-1111-4111-8111-111111111111');
    assert.equal(baseCalled, false);
    assert.deepEqual((result as any).value.data, [meeting]);
  });

  it('returns structured choices instead of guessing a shared connection', async () => {
    const tool = createLarkMeetingTool({
      client: fakeClient,
      userTokenResolver: { resolve: async () => ({
        status: 'choose_connection' as const,
        connections: [{ connectionId: '11111111-1111-4111-8111-111111111111', label: 'Team', access: 'read_only' as const }],
      }) },
      createUserClient: () => fakeClient,
    });

    const result = await tool.execute({ op: 'search' }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual((result as any).value.data, {
      code: 'lark_connection_selection_required',
      connections: [{ connectionId: '11111111-1111-4111-8111-111111111111', label: 'Team', access: 'read_only' }],
    });
  });

  it('does not fall back to an installed app client when Lark access is unavailable', async () => {
    let baseCalled = false;
    const tool = createLarkMeetingTool({
      client: { ...fakeClient, searchMeetings: async () => { baseCalled = true; return []; } },
      userTokenResolver: { resolve: async () => null },
      createUserClient: () => fakeClient,
    });

    const result = await tool.execute({ op: 'search' }, ctx);
    assert.equal(result.ok, false);
    assert.equal((result as any).error.payload.reason, 'unrecoverable');
    assert.equal(baseCalled, false);
  });

  it('requires a meeting ID for detail and recording reads', async () => {
    const tool = createLarkMeetingTool({ client: fakeClient });
    const detail = await tool.execute({ op: 'get' }, ctx);
    const recording = await tool.execute({ op: 'get_recording' }, ctx);

    assert.equal(detail.ok, false);
    assert.equal((detail as any).error.payload.reason, 'bad_args');
    assert.equal(recording.ok, false);
    assert.equal((recording as any).error.payload.reason, 'bad_args');
  });
});
