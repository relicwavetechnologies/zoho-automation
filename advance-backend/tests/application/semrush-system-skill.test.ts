import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DIVO_SEMRUSH_SYSTEM_SKILL } from '../../src/application/skills/semrush-system-skill.ts';
import { SEMRUSH_OPERATIONS } from '../../src/application/semrush/semrush.types.ts';

describe('Semrush system skill', () => {
  it('answers every question dataExport op=plan can ask back', () => {
    // These states are only explained in secure-data-export, which data-router
    // reaches for when a source returned NO candidate. Semrush always returns
    // one, so that skill never loads on this path and the model would be left
    // guessing at a question the backend genuinely asked it.
    for (const state of ['choose_destination', 'connect_required', 'sample_required', 'ambiguous']) {
      assert.match(
        DIVO_SEMRUSH_SYSTEM_SKILL.markdown,
        new RegExp(`\`${state}\``),
        `the skill must say what to do when op=plan returns ${state}`,
      );
    }
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /exact `connectionId`/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /`op=confirm_sample`/);
    // A queued export is not a finished one.
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /started, not that it is finished/);
  });

  it('never tells the model to expose export internals to a member', () => {
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Never show the\s+member a candidate list or any ID/);
  });

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

  it('documents all three callable operations and the excluded senior backlink export curl', () => {
    for (const operation of SEMRUSH_OPERATIONS) {
      assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, new RegExp(`\`${operation}\``));
    }
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Senior curl mapping/i);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /backlinks_comparison/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /domain_overview/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /keyword_position_trend/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /analytics\/backlinks\/webapi2/i);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /403 ERROR 130 API DISABLED/i);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Excluded/i);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Supported backend operations \(3 callable\)/i);
  });

  it('documents web-only env vars without legacy api.semrush.com keys', () => {
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /SEMRUSH_WEB_API_KEY/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /SEMRUSH_WEB_COOKIE/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /SEMRUSH_TIMEOUT_MS/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /never `api\.semrush\.com`/i);
    assert.doesNotMatch(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /SEMRUSH_API_KEY/);
  });
});
