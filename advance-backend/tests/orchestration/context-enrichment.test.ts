import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionSummary, parseSubAgentTrace, stripTraceMarker } from '../../src/application/orchestration/engine/execution-summary.ts';
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

describe('buildExecutionSummary', () => {
  it('formats tool results and filters manageTodos noise', () => {
    const log = buildExecutionSummary([
      { toolName: 'manageTodos', output: 'Created checklist item' },
      { toolName: 'agent_lark_ops', output: 'Task "Prepare agenda" created\nid: 73cd5954' },
      { toolName: 'agent_google_ops', output: 'error: Failed - insufficient Google Calendar permissions' },
    ]);

    assert.ok(log);
    assert.ok(log.startsWith('[Execution]'));
    assert.ok(log.includes('agent_lark_ops'));
    assert.ok(log.includes('agent_google_ops'));
    assert.ok(!log.includes('manageTodos'));
    assert.ok(log.includes('success'));
    assert.ok(log.includes('error'));
  });

  it('returns null when no user-relevant actions were recorded', () => {
    assert.equal(buildExecutionSummary([]), null);
    assert.equal(buildExecutionSummary([{ toolName: 'manageTodos', output: 'updated' }]), null);
  });

  it('truncates long outputs to 800 characters', () => {
    const log = buildExecutionSummary([{ toolName: 'agent_lark_ops', output: 'x'.repeat(1000) }]);
    assert.ok(log);
    assert.ok(log.length < 1000);
  });

  it('parses nested sub-agent tool traces', () => {
    const trace = JSON.stringify([
      { toolName: 'zohoBooks.listInvoices', status: 'success', summary: '5 records' },
    ]);
    const output = `Done.\n<!--TOOL_TRACE:${trace}-->`;
    const log = buildExecutionSummary([{ toolName: 'agent_zoho_ops', output }]);

    assert.ok(log);
    assert.ok(log.includes('Sub-steps:'));
    assert.ok(log.includes('zohoBooks.listInvoices'));
  });
});

describe('parseSubAgentTrace', () => {
  it('parses valid trace marker', () => {
    const entries = [{ toolName: 'foo', status: 'success', summary: 'ok' }];
    const output = `some text\n<!--TOOL_TRACE:${JSON.stringify(entries)}-->`;
    const parsed = parseSubAgentTrace(output);
    assert.ok(parsed);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.toolName, 'foo');
  });

  it('returns null for output without trace marker', () => {
    assert.equal(parseSubAgentTrace('plain text'), null);
  });
});

describe('stripTraceMarker', () => {
  it('strips the trace sentinel from output', () => {
    const output = 'Hello world\n<!--TOOL_TRACE:[{"toolName":"x","status":"success","summary":"ok"}]-->';
    assert.equal(stripTraceMarker(output), 'Hello world');
  });

  it('returns unchanged output when no marker present', () => {
    assert.equal(stripTraceMarker('no marker here'), 'no marker here');
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

  const executionContent = [
    '[Execution]',
    '1. agent_lark_ops → success: Task created',
    '2. agent_zoho_ops → success: Deal updated',
    '',
    '[Reply]',
    'Task created and deal updated.',
    'Second reply line should be dropped in condensed history.',
  ].join('\n');

  it('keeps full-tier turns unchanged', () => {
    const turn = makeTurn('assistant', enrichedContent);
    assert.equal(compactTurn(turn, 'full'), turn);
  });

  it('condenses [Actions] format to actions plus first reply line', () => {
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

  it('condenses [Execution] format to top-level tool lines plus first reply line', () => {
    const compacted = compactTurn(makeTurn('assistant', executionContent), 'condensed');
    assert.ok(compacted.content.includes('[Execution]'));
    assert.ok(compacted.content.includes('agent_lark_ops'));
    assert.ok(compacted.content.includes('agent_zoho_ops'));
    assert.ok(compacted.content.includes('[Reply]'));
    assert.ok(compacted.content.includes('Task created and deal updated.'));
    assert.ok(!compacted.content.includes('Second reply line'));
  });

  it('condenses plain turns to 150 characters', () => {
    const compacted = compactTurn(makeTurn('assistant', 'a'.repeat(180)), 'condensed');
    assert.equal(compacted.content.length, 150);
    assert.ok(compacted.content.endsWith('...'));
  });

  it('minimizes [Actions] format to the user-facing reply, never internal tool names', () => {
    const compacted = compactTurn(makeTurn('assistant', enrichedContent), 'minimal');
    assert.equal(compacted.content, 'Task created and deal updated.');
  });

  it('minimizes [Execution] format to the user-facing reply, never internal tool names', () => {
    const compacted = compactTurn(makeTurn('assistant', executionContent), 'minimal');
    assert.equal(compacted.content, 'Task created and deal updated.');
  });

  it('minimizes plain user turns to 80 characters', () => {
    const compacted = compactTurn(makeTurn('user', 'u'.repeat(100)), 'minimal');
    assert.equal(compacted.content.length, 80);
    assert.ok(compacted.content.endsWith('...'));
  });
});
