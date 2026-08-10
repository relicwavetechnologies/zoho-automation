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
import {
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
    assert.match(router.markdown, /one main Semrush call/);
    assert.match(router.markdown, /local Python workflow only when the operation exposes complete data or truthful continuation/);
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

  it('teaches exact Airtable gateway and record-read shapes', () => {
    assert.match(airtableCoreSkill.instructions, /root `op: "tools\.invoke"`/);
    assert.match(airtableCoreSkill.instructions, /Put `connectionId` inside `payload\.args`, never beside `payload`/);
    assert.match(airtableCoreSkill.instructions, /toolId: "airtableRecords"/);
    assert.match(airtableSchemaOpsSkill.instructions, /toolId: "airtableSchema"/);
    assert.match(airtableAutomationOpsSkill.instructions, /toolId: "airtableAutomation"/);
    assert.match(airtableCoreSkill.instructions, /list_records_for_table input uses `filters` plural, not `filter`/);
    assert.match(airtableCoreSkill.instructions, /search_records has a different input shape/);
    assert.match(airtableCoreSkill.instructions, /Each leaf condition is `\{ operator, operands: \[fieldId, value\] \}`/);
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
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /continuation as incomplete coverage/);
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

  it('keeps each router target list non-empty, unique, and free of self-links', () => {
    for (const seed of SYSTEM_SKILL_ROUTE_SEEDS) {
      assert.ok(seed.targetSlugs.length > 0, `${seed.routerSlug} has no targets`);
      assert.equal(new Set(seed.targetSlugs).size, seed.targetSlugs.length);
      assert.equal(seed.targetSlugs.includes(seed.routerSlug), false);
    }
  });
});
