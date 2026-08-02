import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DIVO_SEMRUSH_SYSTEM_SKILL } from '../../src/application/skills/semrush-system-skill.ts';

describe('Semrush system skill', () => {
  it('is discoverable by SEO terms and constrained to the canonical Semrush tool', () => {
    assert.deepEqual(DIVO_SEMRUSH_SYSTEM_SKILL.toolIds, ['semrush']);
    assert.ok(DIVO_SEMRUSH_SYSTEM_SKILL.aliases.includes('semrush'));
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Do not call Semrush.*directly/i);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /partial/i);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Do not manually follow `nextPage`/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /preserve only that opaque offer/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /present its governed Sheet\/CSV\/XLSX choice once/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Do not.*create or upload a CSV\/XLSX\/Sheet.*run Python or a local workflow.*use Cloudinary.*ask again about the same offer/i);
    assert.doesNotMatch(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /legacy rollback/i);
  });
});
