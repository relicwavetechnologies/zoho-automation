import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertLarkReviewableSkill,
  buildSkillChangeEvidence,
  focusedSkillReviewBlocks,
  LARK_REVIEW_MAX_SKILL_MARKDOWN_CHARS,
} from '../../src/application/knowledge/knowledge-review-presentation.ts';
import { sha256CanonicalJson } from '../../src/shared/hash.ts';

const current = {
  name: 'Cursor Design HTML',
  slug: 'cursor-design-html',
  summary: 'Create HTML interfaces.',
  markdown: [
    '- [ ] Responsive: cards collapse to 1-up below 640px.',
    '- [ ] 8px border-radius on CTAs.',
  ].join('\n'),
  toolIds: [],
  tags: ['design'],
};

test('renders only the exact focused skill change and hides the fingerprint', () => {
  const proposed = {
    ...current,
    markdown: [
      '- [ ] Responsive: cards collapse to 1-up below 640px.',
      '- [ ] Check the interface at a narrow mobile width.',
      '- [ ] 8px border-radius on CTAs.',
    ].join('\n'),
  };
  const result = buildSkillChangeEvidence({
    action: 'update',
    current,
    proposed,
    contentHash: sha256CanonicalJson(proposed),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.evidence.instructionChanges, [
    { kind: 'context', text: '- [ ] Responsive: cards collapse to 1-up below 640px.' },
    { kind: 'added', text: '- [ ] Check the interface at a narrow mobile width.' },
    { kind: 'context', text: '- [ ] 8px border-radius on CTAs.' },
  ]);
  const cardText = focusedSkillReviewBlocks(result.evidence).join('\n');
  assert.match(cardText, /narrow mobile width/);
  assert.doesNotMatch(cardText, /SHA-256|cursor-design-html/);
});

test('fails closed when Lark cannot display the complete procedure', () => {
  const markdown = 'x'.repeat(LARK_REVIEW_MAX_SKILL_MARKDOWN_CHARS + 1);
  assert.match(assertLarkReviewableSkill(markdown) ?? '', /too large for an exact Lark review/i);
});

test('refuses a review whose proposed content does not match the mutation hash', () => {
  const result = buildSkillChangeEvidence({
    action: 'update',
    current,
    proposed: { ...current, summary: 'Changed' },
    contentHash: 'a'.repeat(64),
  });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.message, /fingerprint/);
});
