import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DIVO_SEMRUSH_SYSTEM_SKILL } from '../../src/application/skills/semrush-system-skill.ts';
import { SEMRUSH_OPERATIONS } from '../../src/application/semrush/semrush.types.ts';
import { EnvSchema } from '../../src/config/env.ts';

/*
 * EnvSchema cross-validates fields, so it is a ZodEffects and the declared
 * field list lives on the object it wraps. Exact keys, not a SEMRUSH_ prefix:
 * SEMRUSH_API_KEY_WEBHOOK_URL is a real and separate variable.
 */
const envFields = (EnvSchema as unknown as {
  _def: { schema: { shape: Record<string, unknown> } };
})._def.schema.shape;

describe('Semrush system skill', () => {
  it('forbids treating a country Semrush omitted as a measured zero', () => {
    // Observed 2026-08-08: asked which markets emiactech.com was invisible in,
    // the model listed Germany, Japan, Brazil and five others as "no organic
    // presence whatsoever". Semrush returned 26 databases and said nothing
    // about any of them — the list came from the model's own world knowledge
    // and read as a finding. Absent is unknown, exactly as for a backlinks
    // target with no provider report.
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /missing from `domain_overview` is one Semrush has \*\*no record for\*\*/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /unreturned country is unindexed, has zero traffic, or has no\s+visibility/s);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /same sentence must say this is Semrush having no record/);
    // Stated once now. It was written out twice at length, in the operation
    // list and again in the honesty rules, which is how it drifted apart.
    assert.equal(DIVO_SEMRUSH_SYSTEM_SKILL.markdown.match(/never count how many markets/gi)?.length, 1);
    // A returned row showing 0 is a real measurement and stays reportable.
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /ranking without earning clicks/);
  });

  it('sends every count to the insights field instead of asking for a tally', () => {
    // The same answer said 22 zero-traffic countries and listed 22, dropping
    // Taiwan; the rows held 23. Another turn on the same data said 23. Telling
    // the model to count more carefully did not fix it — which is why the
    // backend counts now and the skill points at the answer rather than asking
    // for a tally.
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Counts come from `insights`/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Never from memory, and never by tallying the table/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /tallying it undercounts a longer run/);
  });

  it('requires every compared target to be reported, and says why that fails silently', () => {
    // Eleven sites came back described as ten. Each number in the answer was
    // right, so the omission was invisible.
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /every target\s+numbered 1\.\.N/s);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /\*\*report every position\*\*/i);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /every number in that answer was\s+correct, which is why nobody caught it/s);
  });

  it('keeps a missing backlinks report out of the weakest slot', () => {
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /insights\.targetsWithoutProviderData/);
    assert.match(
      DIVO_SEMRUSH_SYSTEM_SKILL.markdown,
      /never present one as an authority score of 0 or as the weakest\s+site/s,
    );
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
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /there is nothing to call directly/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Never reach\s+for browser automation, curl, or a local API key/s);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /partial/i);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /continuation as incomplete\s+coverage/s);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /never pull bulk rows through model context/);
    assert.doesNotMatch(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /exportCandidate|dataExport/);
    // Naming a store the tool can no longer reach only tells the model it exists.
    assert.doesNotMatch(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /cloudinary/i);
    assert.doesNotMatch(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /legacy rollback/i);
  });

  it('teaches every callable operation and blocks the ones that are not', () => {
    for (const operation of SEMRUSH_OPERATIONS) {
      assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, new RegExp(`\`${operation}\``));
    }
    /*
     * The provenance table mapping each operation back to the senior's curl
     * calls — including an Excluded row for a probe that answered
     * 403 ERROR 130 API DISABLED — recorded how these operations came to
     * exist. That is history: the tool's `operation` enum is what decides
     * callability, and its parameterDocs already name the three. What the
     * skill still owes the member is the honest refusal.
     */
    assert.doesNotMatch(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Senior curl|webapi2|ERROR 130|Excluded/i);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /not available through Divo Semrush yet/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Never\s+substitute one report for another/s);
  });

  /*
   * This used to assert that the skill body names SEMRUSH_WEB_API_KEY,
   * SEMRUSH_WEB_COOKIE and SEMRUSH_TIMEOUT_MS, under a heading that read
   * "ops only — never expose to members" while sitting in a document the model
   * reads and can quote. The intent — the wired path is the web session, not
   * the retired api.semrush.com key — is real, so it moves to the schema that
   * actually declares the variables. Nothing about which env vars exist
   * changes what Divo should do in a run.
   */
  it('wires only the web-session Semrush variables', () => {
    assert.equal('SEMRUSH_WEB_API_KEY' in envFields, true);
    assert.equal('SEMRUSH_WEB_COOKIE' in envFields, true);
    assert.equal('SEMRUSH_TIMEOUT_MS' in envFields, true);
    assert.equal('SEMRUSH_API_KEY' in envFields, false);
    assert.doesNotMatch(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /SEMRUSH_[A-Z_]+/);
    assert.doesNotMatch(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /api\.semrush\.com/);
  });
});
