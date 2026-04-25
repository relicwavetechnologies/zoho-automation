import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryService } from '../../src/application/orchestration/engine/history.ts';
import type { ConversationRepoPort } from '../../src/infrastructure/persistence/conversation.repository.ts';
import type { PermissionResult } from '../../src/application/permissions/permission.types.ts';
import type { Turn } from '../../src/domain/conversation/turn.ts';
import { HISTORY_POLICY } from '../../src/domain/conversation/history-policy.ts';
import { ok } from '../../src/shared/result.ts';
import { asToolId, asChatId } from '../../src/shared/ids.ts';
import type { Logger } from '../../src/shared/logger.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger: Logger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

const CHAT_ID = asChatId('chat-001');

function makeTurn(id: string, role: Turn['role'], content: string): Turn {
  return { id, role, content, timestamp: new Date().toISOString() };
}

function makeRepo(turns: Turn[]): ConversationRepoPort {
  return {
    getHistory: async () => ok(turns),
    appendTurn: async () => ok(undefined),
    getConversation: async () => ok(null),
    upsertConversation: async () => ok(undefined),
  } as any;
}

function makePermWithTools(...toolIds: string[]): PermissionResult {
  return {
    allowedToolIds: new Set(toolIds.map(id => asToolId(id))) as any,
    allowedActionsByTool: new Map() as any,
    decisions: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('HistoryService.loadWindow', () => {
  it('returns empty window when no history', async () => {
    const svc = new HistoryService({ conversationRepo: makeRepo([]), logger: noopLogger });
    const result = await svc.loadWindow(CHAT_ID, { filterPoison: false });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.turns.length, 0);
    assert.equal(result.value.truncated, false);
  });

  it('returns turns as-is when filterPoison is false', async () => {
    const turns = [
      makeTurn('t1', 'user', 'send a message'),
      makeTurn('t2', 'assistant', 'permission denied for tool larkTask'),
    ];
    const svc = new HistoryService({ conversationRepo: makeRepo(turns), logger: noopLogger });
    const result = await svc.loadWindow(CHAT_ID, { filterPoison: false });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.turns.length, 2);
  });

  it('filters poisoned assistant turn when tool is now allowed', async () => {
    const turns = [
      makeTurn('t1', 'user', 'send a message'),
      makeTurn('t2', 'assistant', 'permission denied for tool larkTask — I cannot help with that'),
      makeTurn('t3', 'user', 'try again'),
    ];
    const perm = makePermWithTools('larkTask');
    const svc = new HistoryService({ conversationRepo: makeRepo(turns), logger: noopLogger });
    const result = await svc.loadWindow(CHAT_ID, { filterPoison: true, perm });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const ids = result.value.turns.map(t => t.id);
    assert.ok(!ids.includes('t2'), 'poisoned turn should be filtered out');
    assert.ok(ids.includes('t1'));
    assert.ok(ids.includes('t3'));
  });

  it('keeps poisoned turn when tool is NOT in allowed set', async () => {
    const turns = [
      makeTurn('t1', 'user', 'do something'),
      makeTurn('t2', 'assistant', 'permission denied for tool larkTask'),
    ];
    const perm = makePermWithTools('larkMessaging'); // larkTask NOT allowed
    const svc = new HistoryService({ conversationRepo: makeRepo(turns), logger: noopLogger });
    const result = await svc.loadWindow(CHAT_ID, { filterPoison: true, perm });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.turns.length, 2);
  });

  it('keeps non-poisoned assistant turns untouched', async () => {
    const turns = [
      makeTurn('t1', 'user', 'list tasks'),
      makeTurn('t2', 'assistant', 'Here are your 3 open tasks: ...'),
    ];
    const perm = makePermWithTools('larkTask');
    const svc = new HistoryService({ conversationRepo: makeRepo(turns), logger: noopLogger });
    const result = await svc.loadWindow(CHAT_ID, { filterPoison: true, perm });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.turns.length, 2);
  });

  it('caps turns to MAX_TURNS', async () => {
    const turns = Array.from({ length: HISTORY_POLICY.MAX_TURNS + 5 }, (_, i) =>
      makeTurn(`t${i}`, 'user', `msg ${i}`),
    );
    const svc = new HistoryService({ conversationRepo: makeRepo(turns), logger: noopLogger });
    const result = await svc.loadWindow(CHAT_ID, { filterPoison: false });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value.turns.length <= HISTORY_POLICY.MAX_TURNS);
  });

  it('applies token budget and truncates oldest turns first', async () => {
    // Create turns with large content that exceeds token budget when combined
    const bigContent = 'x'.repeat(HISTORY_POLICY.MAX_TOKEN_BUDGET * 4); // ~MAX_TOKEN_BUDGET tokens each
    const turns = [
      makeTurn('old', 'user', bigContent),
      makeTurn('recent', 'assistant', 'short reply'),
    ];
    const svc = new HistoryService({ conversationRepo: makeRepo(turns), logger: noopLogger });
    const result = await svc.loadWindow(CHAT_ID, { filterPoison: false });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The big old turn should be dropped; recent short turn should survive
    const ids = result.value.turns.map(t => t.id);
    assert.ok(ids.includes('recent'));
    assert.ok(!ids.includes('old'), 'oversized old turn should be budget-truncated');
  });

  it('sets truncated=true when turns were dropped', async () => {
    const turns = Array.from({ length: HISTORY_POLICY.MAX_TURNS + 3 }, (_, i) =>
      makeTurn(`t${i}`, 'user', 'hi'),
    );
    const svc = new HistoryService({ conversationRepo: makeRepo(turns), logger: noopLogger });
    const result = await svc.loadWindow(CHAT_ID, { filterPoison: false });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.truncated, true);
  });

  it('computes non-zero tokenEstimate for non-empty history', async () => {
    const turns = [makeTurn('t1', 'user', 'hello world')];
    const svc = new HistoryService({ conversationRepo: makeRepo(turns), logger: noopLogger });
    const result = await svc.loadWindow(CHAT_ID, { filterPoison: false });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value.tokenEstimate > 0);
  });

  it('filters multiple poisoned turns in a row', async () => {
    const turns = [
      makeTurn('t1', 'user', 'try 1'),
      makeTurn('t2', 'assistant', 'permission denied for tool larkTask'),
      makeTurn('t3', 'user', 'try 2'),
      makeTurn('t4', 'assistant', 'insufficient permissions — larkTask not allowed'),
      makeTurn('t5', 'user', 'try 3'),
    ];
    const perm = makePermWithTools('larkTask');
    const svc = new HistoryService({ conversationRepo: makeRepo(turns), logger: noopLogger });
    const result = await svc.loadWindow(CHAT_ID, { filterPoison: true, perm });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const ids = result.value.turns.map(t => t.id);
    assert.ok(!ids.includes('t2'));
    assert.ok(!ids.includes('t4'));
    assert.ok(ids.includes('t1'));
    assert.ok(ids.includes('t3'));
    assert.ok(ids.includes('t5'));
  });
});

describe('HistoryService.appendTurn', () => {
  it('delegates to conversationRepo.appendTurn', async () => {
    let recorded: { chatId: string; turn: Omit<Turn, 'id'> } | null = null;
    const repo: ConversationRepoPort = {
      getHistory: async () => ok([]),
      appendTurn: async (chatId, turn) => { recorded = { chatId, turn }; return ok(undefined); },
      getConversation: async () => ok(null),
      upsertConversation: async () => ok(undefined),
    } as any;

    const svc = new HistoryService({ conversationRepo: repo, logger: noopLogger });
    const turn: Omit<Turn, 'id'> = { role: 'user', content: 'hello', timestamp: new Date().toISOString() };
    await svc.appendTurn(CHAT_ID, turn);

    assert.ok(recorded !== null);
    assert.equal(recorded!.turn.content, 'hello');
    assert.equal(recorded!.turn.role, 'user');
  });
});
