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
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /`exportCandidate`/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /call `dataExport` with `op=plan`/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /one soft follow-up asking whether to export it to Google Sheets, Excel, or CSV/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Do not manually follow `nextPage`, create or upload a CSV\/XLSX\/Sheet, run Python or a local workflow/);
    // Naming a store the tool can no longer reach only tells the model it exists.
    assert.doesNotMatch(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /cloudinary/i);
    assert.doesNotMatch(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /legacy rollback/i);
  });
});
