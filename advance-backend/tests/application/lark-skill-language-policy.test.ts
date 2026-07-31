import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isLarkSkill,
  larkSkillCjkFields,
  larkSkillEnglishOnlyError,
} from '../../src/application/skills/lark-skill-language-policy.ts';

const englishLarkSkill = {
  slug: 'lark-documents',
  name: 'Lark Documents',
  summary: 'Create and edit governed Lark documents.',
  markdown: '# Lark Documents\n\nUse the Divo gateway.',
  toolIds: ['larkDoc'],
  tags: ['lark', 'documents'],
};

describe('Lark skill language policy', () => {
  it('recognizes Lark skills from governed metadata without matching names such as Clark', () => {
    assert.equal(isLarkSkill(englishLarkSkill), true);
    assert.equal(isLarkSkill({ ...englishLarkSkill, slug: 'clark-notes', name: 'Clark Notes', toolIds: ['webSearch'], tags: [] }), false);
  });

  it('accepts English Lark skill content', () => {
    assert.deepEqual(larkSkillCjkFields(englishLarkSkill), []);
    assert.equal(larkSkillEnglishOnlyError(englishLarkSkill), null);
  });

  it('reports each CJK field in a Lark skill', () => {
    const candidate = {
      ...englishLarkSkill,
      name: 'Lark 文档',
      summary: 'Create 会议 notes.',
      markdown: '# 文档',
      tags: ['lark', '会議'],
    };

    assert.deepEqual(larkSkillCjkFields(candidate), ['name', 'summary', 'markdown', 'tags']);
    assert.match(larkSkillEnglishOnlyError(candidate) ?? '', /name, summary, markdown, tags/);
  });

  it('does not apply the Lark-only rule to an unrelated skill', () => {
    const unrelated = {
      ...englishLarkSkill,
      slug: 'general-writing',
      name: 'General Writing',
      toolIds: ['webSearch'],
      tags: ['writing'],
      markdown: '# 写作',
    };
    assert.deepEqual(larkSkillCjkFields(unrelated), []);
  });
});
