import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DIVO_SEMRUSH_SYSTEM_SKILL } from '../../src/application/skills/semrush-system-skill.ts';
import { DIVO_OMS_SITE_DATA_SYSTEM_SKILL } from '../../src/application/skills/oms-site-data-system-skill.ts';
import { DATA_EXPORT_SYSTEM_SKILL } from '../../src/application/skills/data-export-system-skill.ts';
import { airtableCoreSkill } from '../../src/application/skills/airtable.skill.ts';
import { zohoBooksReadAnalysisSkill } from '../../src/application/skills/zoho.skill.ts';
import { DIVO_LOCAL_PYTHON_SYSTEM_SKILL } from '../../src/application/skills/divo-local-python-system-skill.ts';
import { CREATE_FILES_SYSTEM_SKILL } from '../../src/application/skills/files-and-documents-system-skills.ts';
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

  it('routes Semrush through the research router', () => {
    const research = SYSTEM_SKILL_ROUTE_SEEDS.find(seed => seed.routerSlug === 'research-router');
    assert.ok(research);
    assert.ok(research.targetSlugs.includes(DIVO_SEMRUSH_SYSTEM_SKILL.slug));
  });

  it('keeps Semrush complete-data exports on the governed offer route', () => {
    const research = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'research-router');
    assert.ok(research);
    assert.match(research.markdown, /preview\.exportOfferId/);
    assert.match(research.markdown, /verified Lark card own the initial export choice and queue/);
    assert.match(research.markdown, /use `dataExport` `op=confirm`/);
  });

  it('routes pasted Google Sheets and Drive Excel workbooks through the data router', () => {
    const data = SYSTEM_SKILL_ROUTE_SEEDS.find(seed => seed.routerSlug === 'data-router');
    assert.ok(data);
    assert.ok(data.targetSlugs.includes('google-sheets'));
    const router = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'data-router')!;
    assert.match(router.markdown, /drive\.google\.com\/file\/d/);
    assert.match(router.markdown, /before Google Drive/);
    assert.match(router.markdown, /never request a download URL or import it directly/);
    assert.ok(router.aliases.includes('convert excel to google sheet'));
  });

  it('keeps provider previews, offers, scripts, Sheets, and attached files on distinct data routes', () => {
    const data = SYSTEM_SKILL_ROUTE_SEEDS.find(seed => seed.routerSlug === 'data-router');
    assert.ok(data);
    assert.ok(data.targetSlugs.includes(DATA_EXPORT_SYSTEM_SKILL.slug));
    assert.ok(data.targetSlugs.includes('divo-python-automation'));
    assert.ok(data.targetSlugs.includes('google-sheets'));
    assert.ok(data.targetSlugs.includes('read-understand-files'));
  });

  it('keeps one-source exports out of Python, file authoring, and provider pagination', () => {
    const data = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'data-router')!;
    const sheets = GOOGLE_WORKSPACE_SYSTEM_SKILLS.find(skill => skill.slug === 'google-sheets')!;

    assert.match(data.markdown, /preview\.exportOfferId.*verified Lark final-response card/s);
    assert.match(data.markdown, /later chooses a\s+Sheet\/CSV\/XLSX format.*call `dataExport` with\s+`op=confirm`/s);
    assert.match(data.markdown, /destinationReferenceId.*resourceRef.*google-sheets/s);
    assert.match(data.markdown, /No eligible Google destination.*connect-and-resume/s);
    assert.match(airtableCoreSkill.instructions, /complete one-table CSV, Excel, or Google Sheet.*secure-data-export/s);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /verified Sheet\/CSV\/XLSX card own the initial choice and queue/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /returned no provider offer.*secure-data-export/s);
    assert.match(CREATE_FILES_SYSTEM_SKILL.markdown, /does not own a complete export from a connected provider/i);
    assert.match(CREATE_FILES_SYSTEM_SKILL.markdown, /later chooses a\s+format in natural language.*call\s+`dataExport` with `op=confirm`/s);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /Never use `preview\.exportOfferId`, `destinationReferenceId`, or `resourceRef`/);
    assert.equal(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.aliases.includes('export data'), false);
    assert.match(sheets.markdown, /Before generic web search/);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /verified Google Sheet, CSV, and Excel buttons/);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /If the member later chooses Excel\/XL\/XLSX, CSV, or Sheet in natural\s+language, call `dataExport` with `op=confirm`/s);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /direct `dataExport` recipe only.*Airtable or Zoho Books.*no provider offer/s);
  });

  it('keeps Semrush and OMS on Divo governed offers without ad-hoc export paths', () => {
    for (const skill of [DIVO_SEMRUSH_SYSTEM_SKILL, DIVO_OMS_SITE_DATA_SYSTEM_SKILL]) {
      assert.match(skill.markdown, /preview\.exportOfferId/);
      assert.match(skill.markdown, /opaque offer/);
      assert.match(skill.markdown, /Sheet\/CSV\/XLSX choice once/);
      assert.match(skill.markdown, /Divo/);
      // The ad-hoc path is gone from the tools, so it is gone from the prompt
      // too: naming a store nothing can reach only advertises it.
      assert.doesNotMatch(skill.markdown, /cloudinary/i);
    }
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
