import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maskToolResults } from '../../src/application/orchestration/engine/tool-result-mask.ts';
import type { Turn } from '../../src/domain/conversation/turn.ts';

function makeTurn(id: string, role: Turn['role'], content: string): Turn {
  return { id, role, content, timestamp: new Date().toISOString() };
}

describe('maskToolResults', () => {
  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(maskToolResults([], 5), []);
  });

  it('keeps all turns verbatim when count <= verbatimCount', () => {
    const turns = [
      makeTurn('1', 'user', 'Show invoices'),
      makeTurn('2', 'assistant', '[Execution]\n1. zohoBooks → success: {"invoices":[...huge data...]}\n\n[Reply]\nYou have 12 invoices.'),
      makeTurn('3', 'user', 'Thanks'),
      makeTurn('4', 'assistant', 'You are welcome.'),
    ];
    const result = maskToolResults(turns, 5);
    assert.equal(result.length, 4);
    assert.equal(result[1]!.content, turns[1]!.content);
  });

  it('masks execution blocks in turns older than verbatimCount', () => {
    const bigOutput = 'x'.repeat(5000);
    const turns: Turn[] = [];
    for (let i = 0; i < 10; i++) {
      turns.push(makeTurn(`u${i}`, 'user', `Question ${i}`));
      if (i < 3) {
        turns.push(makeTurn(`a${i}`, 'assistant', `[Execution]\n1. zohoBooks → success: ${bigOutput}\n\n[Reply]\nHere are the results.`));
      } else {
        turns.push(makeTurn(`a${i}`, 'assistant', `Simple reply ${i}`));
      }
    }

    const result = maskToolResults(turns, 5);
    const firstAssistant = result.find(t => t.id === 'a0')!;
    assert.ok(!firstAssistant.content.includes(bigOutput), 'Old tool output should be masked');
    assert.ok(firstAssistant.content.includes('[Reply]'), '[Reply] section preserved');
    assert.ok(firstAssistant.content.includes('Here are the results'), 'Reply text preserved');
  });

  it('never masks user turns', () => {
    const turns = [
      makeTurn('u1', 'user', 'A very long user message '.repeat(100)),
      makeTurn('a1', 'assistant', 'reply'),
      makeTurn('u2', 'user', 'Another message'),
      makeTurn('a2', 'assistant', 'reply 2'),
      makeTurn('u3', 'user', 'Third'),
      makeTurn('a3', 'assistant', 'reply 3'),
      makeTurn('u4', 'user', 'Fourth'),
      makeTurn('a4', 'assistant', 'reply 4'),
    ];
    const result = maskToolResults(turns, 2);
    assert.equal(result[0]!.content, turns[0]!.content);
  });

  it('does not modify turns without [Execution] block', () => {
    const turns = [
      makeTurn('u1', 'user', 'Hi'),
      makeTurn('a1', 'assistant', 'Hello! How can I help?'),
      makeTurn('u2', 'user', 'Nothing'),
      makeTurn('a2', 'assistant', 'Ok'),
      makeTurn('u3', 'user', 'Bye'),
      makeTurn('a3', 'assistant', 'Goodbye'),
    ];
    const result = maskToolResults(turns, 2);
    assert.equal(result[1]!.content, turns[1]!.content);
  });

  it('extracts count patterns from tool output', () => {
    const output = '[Execution]\n1. zohoBooks → success: listed 47 invoices with total ₹14,62,110.91 for the current period.\n\n[Reply]\n12 overdue invoices.';
    const turns = [
      makeTurn('u1', 'user', 'Show invoices'),
      makeTurn('a1', 'assistant', output),
      makeTurn('u2', 'user', 'Next'),
      makeTurn('a2', 'assistant', 'Done'),
      makeTurn('u3', 'user', 'Next2'),
      makeTurn('a3', 'assistant', 'Done2'),
      makeTurn('u4', 'user', 'Next3'),
      makeTurn('a4', 'assistant', 'Done3'),
      makeTurn('u5', 'user', 'Next4'),
      makeTurn('a5', 'assistant', 'Done4'),
      makeTurn('u6', 'user', 'Next5'),
      makeTurn('a6', 'assistant', 'Done5'),
    ];
    const result = maskToolResults(turns, 5);
    const masked = result[1]!.content;
    assert.ok(masked.includes('zohoBooks'), 'Tool name preserved');
    assert.ok(masked.includes('[Reply]'), '[Reply] preserved');
    assert.ok(masked.length < output.length, 'Content was compressed');
  });
});
