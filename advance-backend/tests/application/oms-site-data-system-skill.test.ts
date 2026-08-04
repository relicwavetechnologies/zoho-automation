import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DIVO_OMS_SITE_DATA_SYSTEM_SKILL } from '../../src/application/skills/oms-site-data-system-skill.ts';

describe('OMS Site Data system skill', () => {
  it('is discoverable for inventory research and constrained to the canonical OMS tool', () => {
    assert.deepEqual(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.toolIds, ['omsSiteData']);
    assert.ok(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.aliases.includes('oms'));
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /never call the OMS webhook/i);
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /ambiguous/i);
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /company administrators/i);
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /`exportCandidate`/);
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /call `dataExport` with `op=plan`/);
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /one soft follow-up asking whether to export it to Google Sheets, Excel, or CSV/);
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /local Python workflow/i);
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /temporary download link/);
    // Naming a store the tool can no longer reach only tells the model it exists.
    assert.doesNotMatch(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /cloudinary/i);
  });
});
