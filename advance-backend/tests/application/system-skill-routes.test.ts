import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DIVO_SEMRUSH_SYSTEM_SKILL } from '../../src/application/skills/semrush-system-skill.ts';
import { DIVO_OMS_SITE_DATA_SYSTEM_SKILL } from '../../src/application/skills/oms-site-data-system-skill.ts';
import {
  airtableAutomationOpsSkill,
  airtableCoreSkill,
  airtableSchemaOpsSkill,
} from '../../src/application/skills/airtable.skill.ts';
import { MENHOOD_DATA_SYSTEM_SKILL } from '../../src/application/skills/menhood-data-system-skill.ts';
import { zohoBooksReadAnalysisSkill } from '../../src/application/skills/zoho.skill.ts';
import { DIVO_LOCAL_PYTHON_SYSTEM_SKILL } from '../../src/application/skills/divo-local-python-system-skill.ts';
import { GOOGLE_WORKSPACE_SYSTEM_SKILLS } from '../../src/application/skills/google-workspace-system-skills.ts';
import { DIVO_PRESENTATIONS_SYSTEM_SKILL } from '../../src/application/skills/divo-presentations-system-skill.ts';
import {
  ROUTABLE_SEEDED_SYSTEM_SKILL_SLUGS,
  ROUTING_SYSTEM_SKILLS,
  SYSTEM_SKILL_ROUTE_SEEDS,
  unroutedSeededSystemSkillSlugs,
} from '../../src/application/skills/system-skill-routes.ts';

describe('system skill routes', () => {
  it('routes every seeded executable system skill through at least one router', () => {
    assert.deepEqual(unroutedSeededSystemSkillSlugs(), []);
  });

  it('routes Semrush through research without promising unavailable bulk coverage', () => {
    const route = SYSTEM_SKILL_ROUTE_SEEDS.find(seed => seed.routerSlug === 'research-router');
    const router = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'research-router');
    assert.ok(route?.targetSlugs.includes(DIVO_SEMRUSH_SYSTEM_SKILL.slug));
    assert.ok(router);
    /*
     * How many Semrush calls a question takes, and how bounded the answer is,
     * are execution decisions. They sat in the router, which only has to pick
     * a specialist, and are now stated once by the specialist that makes them.
     */
    assert.match(router.markdown, /which owns how many calls that takes/);
    assert.doesNotMatch(router.markdown, /one main Semrush call|backlinks_comparison/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /\*\*one\*\*\n?\s*`backlinks_comparison`/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Show one main table in chat/);
    assert.doesNotMatch(`${router.markdown}\n${DIVO_SEMRUSH_SYSTEM_SKILL.markdown}`, /exportCandidate|dataExport/);
  });

  it('keeps complete artifacts on source → local file workflow → destination', () => {
    const route = SYSTEM_SKILL_ROUTE_SEEDS.find(seed => seed.routerSlug === 'data-router');
    const router = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'data-router')!;
    const sheets = GOOGLE_WORKSPACE_SYSTEM_SKILLS.find(skill => skill.slug === 'google-sheets')!;

    for (const slug of ['divo-python-automation', 'google-sheets', 'google-drive', 'read-understand-files']) {
      assert.ok(route?.targetSlugs.includes(slug), `data-router missing ${slug}`);
    }
    assert.match(router.markdown, /source specialist plus `divo-python-automation`, then the\s+destination specialist/s);
    assert.match(router.markdown, /reconcile source,\s+written, and read-back counts/s);
    assert.match(router.markdown, /source exposes no complete paging\s+contract, say that plainly/s);
    assert.match(router.markdown, /destinationReferenceId.*google-sheets/s);
    assert.doesNotMatch(router.markdown, /resourceRef/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /use the local Python workflow/);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /protected JSON file inside `DIVO_RUN_DIR`/);
    assert.match(sheets.markdown, /Before generic web search/);
    assert.doesNotMatch(router.markdown, /exportCandidate|dataExport|secure-data-export/);
  });

  it('sends each Airtable job to its own registered tool, without a gateway envelope', () => {
    /*
     * These three skills taught the divo_gateway wrapper — root
     * `op: "tools.invoke"` around `payload: { toolId, args }`, with a rule
     * about which level `connectionId` sits at. That mega-tool is deleted and
     * each family is a registered typed tool, so the envelope is not just
     * unnecessary, it is rejected. The test asserted the envelope, so the
     * suite was holding a deleted call shape in place.
     */
    for (const skill of [airtableCoreSkill, airtableSchemaOpsSkill, airtableAutomationOpsSkill]) {
      assert.doesNotMatch(skill.instructions, /tools\.invoke|payload\.args|divo_gateway|call_tool/);
    }
    assert.match(airtableCoreSkill.instructions, /goes through `airtableRecords`/);
    assert.match(airtableSchemaOpsSkill.instructions, /goes through `airtableSchema`/);
    assert.match(airtableAutomationOpsSkill.instructions, /goes through `airtableAutomation`/);
    /*
     * AirtableContractBootstrapService binds list_records_for_table before
     * inference for every record run, precisely because its filter tree is a
     * nested union no model rebuilds correctly from prose. The skill wrote the
     * tree, the leaf-condition shape, and the date value/range objects out in
     * full anyway, and this test pinned them there. What the skill still owes
     * is the part no schema encodes.
     */
    assert.match(airtableCoreSkill.instructions, /Build the `filters` tree from the bound `list_records_for_table` contract/);
    assert.match(airtableCoreSkill.instructions, /never send `filter` singular/);
    assert.match(airtableCoreSkill.instructions, /are not interchangeable/);
    assert.doesNotMatch(airtableCoreSkill.instructions, /operands: \[fieldId, value\]|mode: "exactDate"|thisCalendarYear/);
    // Divo synthesizes list_fields_for_table, so nothing is ever bound for it.
    assert.match(airtableCoreSkill.instructions, /no contract is ever bound for that one/);
    // A named calendar month is not a rolling window: this one changes the answer.
    assert.match(airtableCoreSkill.instructions, /Filtering July with pastMonth answers a different question/);
  });

  it('keeps direct Airtable reads bounded while naming trusted local page mode', () => {
    assert.match(airtableCoreSkill.instructions, /Ordinary direct `op: "call"` record reads return a small preview/);
    assert.match(airtableCoreSkill.instructions, /`op: "page"`/);
    assert.match(airtableCoreSkill.instructions, /available only through `divo-local`/);
    assert.match(airtableCoreSkill.instructions, /follow each returned `nextCursor` until `hasMore=false`/);
    assert.match(airtableCoreSkill.instructions, /`metadata\.totalRecordCount`/);
    assert.match(airtableCoreSkill.instructions, /Never derive a distribution, share, percentage, average, minimum, maximum, date range, or sum/);
  });

  it('pins fixed months to exact Airtable date bounds', () => {
    assert.match(airtableCoreSkill.instructions, /A date operand is never a bare date string/);
    assert.match(airtableCoreSkill.instructions, /`timeZone` is always required/);
    assert.match(airtableCoreSkill.instructions, /`pastMonth` is a rolling window ending today, not a calendar month/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /never a relative window such as `pastMonth` or `thisCalendarMonth`/);
  });

  it('keeps Semrush and OMS truthful about bounded provider coverage', () => {
    for (const skill of [DIVO_SEMRUSH_SYSTEM_SKILL, DIVO_OMS_SITE_DATA_SYSTEM_SKILL]) {
      assert.doesNotMatch(skill.markdown, /exportCandidate|dataExport|cloudinary/i);
    }
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /continuation as incomplete\s+coverage/s);
    assert.match(DIVO_OMS_SITE_DATA_SYSTEM_SKILL.markdown, /never paginates and never returns a total count/i);
  });

  it('contains representative low-hint data routing examples', () => {
    const data = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'data-router')!;
    for (const phrase of [
      'Show me our best keywords',
      'Put the complete keyword result in a Sheet',
      'Combine invoices with Airtable owners and calculate totals',
      'Add a Notes column to that Sheet',
    ]) {
      assert.ok(data.markdown.includes(phrase), `missing routing example: ${phrase}`);
    }
  });

  /*
   * `divo-presentations` provisioned for every company, appeared in the
   * registry, and no router pointed at it — while `unroutedSeededSystemSkillSlugs`
   * returned []. The guard was not passing; it could not see the skill, because
   * ROUTABLE_SEEDED_SYSTEM_SKILL_SLUGS never listed it. A definition missing
   * from that list is exempt from the only check that would notice.
   */
  it('sees every seeded skill it claims to check', () => {
    assert.ok(ROUTABLE_SEEDED_SYSTEM_SKILL_SLUGS.includes(DIVO_PRESENTATIONS_SYSTEM_SKILL.slug));
    const files = SYSTEM_SKILL_ROUTE_SEEDS.find(seed => seed.routerSlug === 'files-router')!;
    assert.ok(files.targetSlugs.includes(DIVO_PRESENTATIONS_SYSTEM_SKILL.slug));
    const router = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'files-router')!;
    assert.match(router.markdown, /slide deck or presentation/);
  });

  it('keeps each router target list non-empty, unique, and free of self-links', () => {
    for (const seed of SYSTEM_SKILL_ROUTE_SEEDS) {
      assert.ok(seed.targetSlugs.length > 0, `${seed.routerSlug} has no targets`);
      assert.equal(new Set(seed.targetSlugs).size, seed.targetSlugs.length);
      assert.equal(seed.targetSlugs.includes(seed.routerSlug), false);
    }
  });
});
