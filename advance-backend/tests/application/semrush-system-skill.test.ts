import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DIVO_SEMRUSH_SYSTEM_SKILL } from '../../src/application/skills/semrush-system-skill.ts';
import { SEMRUSH_OPERATIONS } from '../../src/application/semrush/semrush.types.ts';

describe('Semrush system skill', () => {
  it('forbids treating a country Semrush omitted as a measured zero', () => {
    // Observed 2026-08-08: asked which markets emiactech.com was invisible in,
    // the model listed Germany, Japan, Brazil and five others as "no organic
    // presence whatsoever". Semrush returned 26 databases and said nothing
    // about any of them — the list came from the model's own world knowledge
    // and read as a finding. Absent is unknown, exactly as for a backlinks
    // target with no provider report.
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /A country missing from that list is one Semrush has no record for/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Never write that an absent country is unindexed, has zero traffic, or has no visibility/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /say in the same sentence that Semrush has no record of it/);
    // A returned row showing 0 is a real measurement and stays reportable.
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /ranking without earning clicks/);
  });

  it('sends every count to the insights field instead of asking for a tally', () => {
    // The same answer said 22 zero-traffic countries and listed 22, dropping
    // Taiwan; the rows held 23. Another turn on the same data said 23. Telling
    // the model to count more carefully did not fix that, so the backend now
    // counts and the skill points at the answer.
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Counts come from `insights`, not from counting/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Every "how many" and "how much" answer quotes a field from there/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Never tally the preview instead/);
  });

  it('requires every compared target to be reported, and says why that fails silently', () => {
    // Eleven sites came back described as ten. Each number in the answer was
    // right, so the omission was invisible.
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /every target numbered 1\.\.N/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /\*\*Report every position\.\*\*/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /because each number in it is correct/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /More than ten named domains means more than one call/);
  });

  it('keeps a missing backlinks report out of the weakest slot', () => {
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /never present a missing report as an authority score of 0 or as the weakest site/);
  });

  /*
   * The derived-column test that stood here described the columns Divo added to
   * an exported file. The export it described was retired with the rest of the
   * data-export pipeline, and the assertion three tests below now checks the
   * opposite — that the skill mentions no export at all.
   */

  it('is discoverable by SEO terms and constrained to the canonical Semrush tool', () => {
    assert.deepEqual(DIVO_SEMRUSH_SYSTEM_SKILL.toolIds, ['semrush']);
    assert.ok(DIVO_SEMRUSH_SYSTEM_SKILL.aliases.includes('semrush'));
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Do not call Semrush.*directly/i);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /partial/i);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /continuation as incomplete coverage/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /never pull bulk rows through model context/);
    assert.doesNotMatch(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /exportCandidate|dataExport/);
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
