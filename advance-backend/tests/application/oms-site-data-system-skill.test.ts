import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DIVO_OMS_SITE_DATA_SYSTEM_SKILL } from '../../src/application/skills/oms-site-data-system-skill.ts';

describe('OMS Site Data system skill', () => {
  it('is discoverable for inventory research and constrained to the canonical OMS tool', () => {
    assert.deepEqual(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.toolIds, ['omsSiteData']);
    assert.ok(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.aliases.includes('oms'));
    assert.ok(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.aliases.includes('email sanitizer'));
    assert.ok(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.aliases.includes('vendor lookup'));
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /sanitize_website_inputs/i);
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /lookup_vendors/i);
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /vendor_fetch/i);
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /never call the OMS webhook/i);
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /ambiguous/i);
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /company administrators/i);
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /OMS never paginates and never returns a total count/);
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /bounded returned snapshot/);
    assert.doesNotMatch(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /exportCandidate|dataExport/);
    // Naming a store the tool can no longer reach only tells the model it exists.
    assert.doesNotMatch(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /cloudinary/i);
  });
});
