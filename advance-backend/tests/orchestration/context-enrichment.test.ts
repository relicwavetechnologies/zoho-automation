import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildActionLog } from '../../src/application/orchestration/engine/core.ts';
import { compactTurn } from '../../src/application/orchestration/engine/history.ts';
import type { Turn } from '../../src/domain/conversation/turn.ts';

function makeTurn(role: Turn['role'], content: string): Turn {
  return {
    id: 'turn-1',
    role,
    content,
    timestamp: '2026-05-06T00:00:00.000Z',
  };
}

describe('buildActionLog', () => {
  it('formats non-internal tool results and filters manageTodos noise', () => {
    const log = buildActionLog([
      { toolName: 'manageTodos', output: 'Created checklist item' },
      { toolName: 'agent_lark_ops', output: 'Task "Prepare agenda" created\nid: 73cd5954' },
      { toolName: 'agent_google_ops', output: 'Failed - insufficient Google Calendar permissions' },
    ]);

    assert.equal(
      log,
      [
        '- agent_lark_ops: Task "Prepare agenda" created id: 73cd5954',
        '- agent_google_ops: Failed - insufficient Google Calendar permissions',
      ].join('\n'),
    );
  });

  it('returns null when no user-relevant actions were recorded', () => {
    assert.equal(buildActionLog([]), null);
    assert.equal(buildActionLog([{ toolName: 'manageTodos', output: 'updated' }]), null);
  });

  it('truncates long action outputs to 200 characters', () => {
    const log = buildActionLog([{ toolName: 'agent_lark_ops', output: 'x'.repeat(220) }]);
    assert.ok(log);
    const output = log.split(': ')[1]!;
    assert.equal(output.length, 200);
    assert.ok(output.endsWith('...'));
  });
});

describe('compactTurn', () => {
  const enrichedContent = [
    '[Actions]',
    '- agent_lark_ops: Task created',
    '- agent_zoho_ops: Deal updated',
    '',
    '[Reply]',
    'Task created and deal updated.',
    'Second reply line should be dropped in condensed history.',
  ].join('\n');

  it('keeps full-tier turns unchanged', () => {
    const turn = makeTurn('assistant', enrichedContent);
    assert.equal(compactTurn(turn, 'full'), turn);
  });

  it('condenses enriched assistant turns to actions plus first reply line', () => {
    const compacted = compactTurn(makeTurn('assistant', enrichedContent), 'condensed');
    assert.equal(
      compacted.content,
      [
        '[Actions]',
        '- agent_lark_ops: Task created',
        '- agent_zoho_ops: Deal updated',
        '',
        '[Reply]',
        'Task created and deal updated.',
      ].join('\n'),
    );
  });

  it('condenses plain turns to 150 characters', () => {
    const compacted = compactTurn(makeTurn('assistant', 'a'.repeat(180)), 'condensed');
    assert.equal(compacted.content.length, 150);
    assert.ok(compacted.content.endsWith('...'));
  });

  it('minimizes enriched assistant turns to called tool names only', () => {
    const compacted = compactTurn(makeTurn('assistant', enrichedContent), 'minimal');
    assert.equal(compacted.content, '[Called: agent_lark_ops, agent_zoho_ops]');
  });

  it('minimizes plain user turns to 80 characters', () => {
    const compacted = compactTurn(makeTurn('user', 'u'.repeat(100)), 'minimal');
    assert.equal(compacted.content.length, 80);
    assert.ok(compacted.content.endsWith('...'));
  });
});
