import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AgentSeatService } from '../../src/application/agent-seat/agent-seat.service.ts';
import {
  AGENT_SEAT_SESSION_VERSION,
  appendHistory,
  saveAgentSeatSession,
  type AgentSeatSession,
} from '../../src/application/agent-seat/agent-seat-session.ts';
import {
  resolveAgentSeatDeliveryChatId,
} from '../../src/application/agent-seat/agent-seat-delivery-chat.ts';
import {
  resolveHarnessOpenId,
  resolveHarnessTenantKey,
} from '../../src/application/agent-seat/harness-identity.ts';
import { gatewaySuccess } from '../../src/application/gateway/gateway.types.ts';
import { ok } from '../../src/shared/result.ts';

describe('harness-identity', () => {
  it('requires a non-empty user selector', async () => {
    await assert.rejects(
      resolveHarnessOpenId({ channelIdentity: { findMany: async () => [] } }, '   '),
      /selector is required/i,
    );
  });

  it('resolves a unique Lark open_id', async () => {
    const openId = await resolveHarnessOpenId({
      channelIdentity: {
        findMany: async () => [{ larkOpenId: 'ou_test', displayName: 'Test', email: 't@example.com' }],
      },
    }, 't@example.com');
    assert.equal(openId, 'ou_test');
  });

  it('resolves a single tenant key', async () => {
    const tenant = await resolveHarnessTenantKey({
      channelIdentity: {
        findMany: async () => [{ externalTenantId: 'tenant-1' }],
      },
    }, 'co-test', 'ou_test');
    assert.equal(tenant, 'tenant-1');
  });
});

describe('agent-seat delivery chat', () => {
  it('requires cli or env chat id', () => {
    assert.throws(
      () => resolveAgentSeatDeliveryChatId({}),
      /requires a Lark delivery chat id/i,
    );
  });

  it('accepts a valid Lark chat id', () => {
    assert.equal(
      resolveAgentSeatDeliveryChatId({ cliChatId: 'oc_testharnesschat0001' }),
      'oc_testharnesschat0001',
    );
  });
});

describe('AgentSeatService', () => {
  const TEST_DELIVERY_CHAT_ID = 'oc_testharnesschat0001';
  const identity = {
    userId: 'user-test',
    companyId: 'co-test',
    email: 'abhishek@emiactech.com',
    displayName: 'Abhishek',
    aiRole: 'MEMBER',
    activeDepartmentId: 'dept-test',
  };

  function serviceWith(sessionPath: string, dispatcher = createDispatcher()) {
    return new AgentSeatService({
      prisma: {
        channelIdentity: {
          findMany: async () => [{ externalTenantId: 'tenant-1' }],
        },
      },
      channelIdentityRepo: {
        resolveByLarkOpenId: async () => ok(identity),
      },
      gatewayDispatcher: dispatcher,
      sessionPath,
      now: () => new Date('2026-08-05T00:00:00.000Z'),
    });
  }

  it('initializes a session with the configured delivery chat id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-seat-init-'));
    const sessionPath = join(directory, 'session.json');
    try {
      const service = serviceWith(sessionPath, createDispatcher());
      const session = await service.init({
        userSelector: 'abhishek@emiactech.com',
        deliveryChatId: TEST_DELIVERY_CHAT_ID,
      });
      assert.equal(session.chatId, TEST_DELIVERY_CHAT_ID);
      assert.equal(session.version, AGENT_SEAT_SESSION_VERSION);
      assert.equal(session.departmentId, 'dept-test');
      assert.match(session.runtimeRunId, /^agent-seat-run-/);
      const saved = JSON.parse(await readFile(sessionPath, 'utf8')) as AgentSeatSession;
      assert.equal(saved.userId, 'user-test');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('builds bootstrap from capabilities and router skills', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-seat-bootstrap-'));
    const sessionPath = join(directory, 'session.json');
    try {
      const service = serviceWith(sessionPath);
      const session = await service.init({
        userSelector: 'abhishek@emiactech.com',
        deliveryChatId: TEST_DELIVERY_CHAT_ID,
      });
      const bootstrap = await service.bootstrap(session);
      assert.equal(bootstrap.ok, true);
      const data = bootstrap.data as {
        capabilities: { skills: Array<{ slug: string }> };
        routers: { skills: Array<{ slug: string }> };
      };
      assert.equal(data.capabilities.skills[0]!.slug, 'divo-semrush-seo-research');
      assert.equal(data.routers.skills[0]!.slug, 'research-router');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('invokes tools with lark runtime execution context', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-seat-invoke-'));
    const sessionPath = join(directory, 'session.json');
    const calls: unknown[] = [];
    const dispatcher = {
      dispatch: async (request: unknown, member: unknown) => {
        calls.push({ request, member });
        return gatewaySuccess({ ok: true });
      },
    };
    try {
      const service = serviceWith(sessionPath, dispatcher as any);
      const session = await service.init({
        userSelector: 'abhishek@emiactech.com',
        deliveryChatId: TEST_DELIVERY_CHAT_ID,
      });
      const turn = await service.beginTurn(session);
      const { response } = await service.invoke(turn, 'semrush', { operation: 'domain_overview', domain: 'a.com', database: 'us' });
      assert.equal(response.ok, true);
      assert.equal(calls.length, 1);
      const call = calls[0] as {
        request: { op: string; execution?: { threadId: string; runId: string } };
        member: { channel: string; runtimeChatId: string };
      };
      assert.equal(call.request.op, 'tools.invoke');
      assert.equal(call.member.channel, 'lark');
      assert.equal(call.member.runtimeChatId, TEST_DELIVERY_CHAT_ID);
      assert.equal(call.request.execution?.threadId, turn.runtimeThreadId);
      assert.equal(call.request.execution?.runId, turn.runtimeRunId);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('begins a new turn and appends notes to history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-seat-turn-'));
    const sessionPath = join(directory, 'session.json');
    try {
      const service = serviceWith(sessionPath);
      let session = await service.init({
        userSelector: 'abhishek@emiactech.com',
        deliveryChatId: TEST_DELIVERY_CHAT_ID,
      });
      session = await service.beginTurn(session);
      assert.equal(session.turn, 1);
      session = await service.addNote(session, 'Skill should forbid per-domain overview fan-out');
      assert.equal(session.notes.length, 1);
      assert.equal(session.history.at(-1)?.kind, 'note');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('round-trips session files through appendHistory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-seat-roundtrip-'));
    const sessionPath = join(directory, 'session.json');
    try {
      const base: AgentSeatSession = {
        version: AGENT_SEAT_SESSION_VERSION,
        sessionId: 'sess-1',
        createdAt: '2026-08-05T00:00:00.000Z',
        userSelector: 'abhishek@emiactech.com',
        userId: 'user-test',
        companyId: 'co-test',
        departmentId: 'dept-test',
        larkOpenId: 'ou_test',
        email: 'abhishek@emiactech.com',
        displayName: 'Abhishek',
        aiRole: 'MEMBER',
        larkTenantKey: 'tenant-1',
        chatId: TEST_DELIVERY_CHAT_ID,
        runtimeRunId: 'agent-seat-run-sess-1',
        runtimeThreadId: 'agent-seat-sess-1',
        turn: 1,
        traceId: 'trace-1',
        history: [],
        notes: [],
      };
      const updated = appendHistory(base, { kind: 'note', note: 'test' });
      await saveAgentSeatSession(updated, sessionPath);
      const service = serviceWith(sessionPath);
      const loaded = await service.loadSession();
      assert.equal(loaded.history.length, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function createDispatcher() {
  return {
    dispatch: async (request: { op: string }) => {
      if (request.op === 'capabilities.get') {
        return gatewaySuccess({
          skills: [{ id: 'skill-semrush', slug: 'divo-semrush-seo-research', name: 'Semrush', description: '' }],
          tools: [{ toolId: 'semrush', allowedActions: ['read'] }],
        });
      }
      if (request.op === 'skills.list') {
        return gatewaySuccess({
          registryRevision: 1,
          skills: [{ id: 'skill-router', slug: 'research-router', name: 'Research Router', description: '', revision: 1 }],
        });
      }
      if (request.op === 'skills.get') {
        return gatewaySuccess({
          skill: {
            id: 'skill-semrush',
            slug: 'divo-semrush-seo-research',
            name: 'Semrush',
            description: '',
            instructions: '# Semrush\nShy answer rules',
            toolIds: ['semrush'],
            revision: 1,
          },
        });
      }
      if (request.op === 'skills.search') {
        return gatewaySuccess({ skills: [{ id: 'skill-router', slug: 'research-router' }] });
      }
      return gatewaySuccess({});
    },
  };
}
