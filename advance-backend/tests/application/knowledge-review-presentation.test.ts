import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertLarkReviewableSkill,
  exactSkillReviewBlocks,
  LARK_REVIEW_MAX_SKILL_MARKDOWN_CHARS,
} from '../../src/application/knowledge/knowledge-review-presentation.ts';

test('renders every procedure character and a stable fingerprint without truncation copy', () => {
  const markdown = Array.from({ length: 8_000 }, (_, index) => String(index % 10)).join('');
  const blocks = exactSkillReviewBlocks({ name: 'Document process', summary: 'Exact steps', markdown });
  const cardText = blocks.join('');
  assert.match(cardText, /SHA-256/);
  assert.doesNotMatch(cardText, /content continues|…/i);
  for (const digit of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
    assert.ok(cardText.includes(digit));
  }
  assert.ok(blocks.length > 2);
});

test('fails closed when Lark cannot display the complete procedure', () => {
  const markdown = 'x'.repeat(LARK_REVIEW_MAX_SKILL_MARKDOWN_CHARS + 1);
  assert.match(assertLarkReviewableSkill(markdown) ?? '', /too large for an exact Lark review/i);
  assert.throws(() => exactSkillReviewBlocks({ name: 'Too large', summary: '', markdown }), /too large/);
});

test('preserves procedure markdown for the centralized Lark renderer', () => {
  const blocks = exactSkillReviewBlocks({
    name: 'Button test',
    summary: 'Two rendered steps',
    markdown: '# Button test\n\n1. Reply with **STARTED**\n2. Reply with `FINISHED`',
  });
  const procedure = blocks.slice(1).join('');
  assert.match(procedure, /^# Button test/);
  assert.match(procedure, /\*\*STARTED\*\*/);
  assert.match(procedure, /`FINISHED`/);
  assert.doesNotMatch(procedure, /\\\*|\\`/);
});
