import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DIVO_SEMRUSH_SYSTEM_SKILL } from '../../src/application/skills/semrush-system-skill.ts';
import { DIVO_OMS_SITE_DATA_SYSTEM_SKILL } from '../../src/application/skills/oms-site-data-system-skill.ts';
import { DATA_EXPORT_SYSTEM_SKILL } from '../../src/application/skills/data-export-system-skill.ts';
import { DATA_EXPORT_MENHOOD_SPOOL_MB_LIMIT } from '../../src/application/data-export/data-export-limits.ts';
import {
  airtableAutomationOpsSkill,
  airtableCoreSkill,
  airtableSchemaOpsSkill,
} from '../../src/application/skills/airtable.skill.ts';
import { MENHOOD_DATA_SYSTEM_SKILL } from '../../src/application/skills/menhood-data-system-skill.ts';
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

  it('keeps Semrush complete-data exports on the governed candidate route', () => {
    const research = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'research-router');
    assert.ok(research);
    assert.match(research.markdown, /exportCandidate/);
    assert.match(research.markdown, /`op=list_candidates`/);
    assert.match(research.markdown, /`op=plan`/);
    assert.match(research.markdown, /one main Semrush call/);
  });

  it('teaches shy Semrush answering and model-planned export', () => {
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Shy answering/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /backlinks_comparison/);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Do not also call `domain_overview` per domain/);
    // Three invariants, matched on the shortest token that carries each one:
    // the export is planned from the answer the member was just shown, the
    // candidate list is reachable when that is unclear, and no candidate
    // identifier is ever put in front of the member. Matching whole sentences
    // here is what forced every past rewrite to reproduce the old wording.
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /in your last answer/);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /op=list_candidates/);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /Never show the member a candidate ID/);
  });

  it('routes pasted Google Sheets and Drive Excel workbooks through the data router', () => {
    const data = SYSTEM_SKILL_ROUTE_SEEDS.find(seed => seed.routerSlug === 'data-router');
    assert.ok(data);
    assert.ok(data.targetSlugs.includes('google-sheets'));
    assert.ok(data.targetSlugs.includes('google-drive'));
    const router = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'data-router')!;
    assert.match(router.markdown, /drive\.google\.com\/file\/d/);
    assert.match(router.markdown, /`google-drive` first/);
    assert.match(router.markdown, /get_drive_file_content/);
    assert.match(router.markdown, /`google-sheets`/);
    assert.match(router.markdown, /never\s+request a download URL or import the workbook directly/);
    assert.ok(router.aliases.includes('convert excel to google sheet'));
    assert.ok(router.aliases.includes('read spreadsheet link'));
    assert.ok(router.aliases.includes('check row in export'));
  });

  it('keeps provider previews, candidates, scripts, Sheets, and attached files on distinct data routes', () => {
    const data = SYSTEM_SKILL_ROUTE_SEEDS.find(seed => seed.routerSlug === 'data-router');
    assert.ok(data);
    assert.ok(data.targetSlugs.includes(DATA_EXPORT_SYSTEM_SKILL.slug));
    assert.ok(data.targetSlugs.includes('divo-python-automation'));
    assert.ok(data.targetSlugs.includes('google-sheets'));
    assert.ok(data.targetSlugs.includes('google-drive'));
    assert.ok(data.targetSlugs.includes('read-understand-files'));
  });

  it('routes provider exports through one company-owned boundary and keeps Python for bespoke work', () => {
    const data = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'data-router')!;
    const sheets = GOOGLE_WORKSPACE_SYSTEM_SKILLS.find(skill => skill.slug === 'google-sheets')!;

    // The router's job is the choice, so it is asserted on the choice: a
    // candidate or a file request goes to the export specialist, and each
    // opaque handle has exactly one owning route.
    assert.match(data.markdown, /`exportCandidate` →\s+`secure-data-export`/s);
    assert.match(data.markdown, /company-account\s+destination policy/s);
    assert.doesNotMatch(data.markdown, /`op=sample`|`op=confirm_sample`|sample_required/);
    assert.match(data.markdown, /destinationReferenceId.*resourceRef.*google-sheets/s);
    assert.match(data.markdown, /xlsx[\s\S]*csv[\s\S]*google-drive/);
    // `op=plan` mechanics and the missing-destination message belong to the
    // export specialist that owns the tool, not to the router that picks it.
    assert.doesNotMatch(data.markdown, /op=plan|op=list_candidates|op=confirm/);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /an administrator must configure or reconnect it/);
    assert.match(airtableCoreSkill.instructions, /If a preview says more rows exist, do not page through Airtable MCP/);
    assert.match(airtableCoreSkill.instructions, /Menhood settled historical totals.*switch to `menhood-data` instead of paging Airtable MCP/s);
    assert.match(airtableCoreSkill.instructions, /use live Airtable for narrow current\/recent Menhood order counts/);
    assert.match(airtableCoreSkill.instructions, /perform the live read yourself; do not ask whether to check Airtable/);
    assert.match(airtableCoreSkill.instructions, /Duplicate\/TEST\/Testing cleanup/);
    assert.match(airtableCoreSkill.instructions, /If an exact replayable source exists.*one soft follow-up/s);
    assert.match(airtableCoreSkill.instructions, /not to export, not now, or chat-only/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /load `secure-data-export`/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /company Google account/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /`dataExport op=plan`/);
    assert.match(CREATE_FILES_SYSTEM_SKILL.markdown, /does not own a complete export from a connected provider/i);
    assert.match(CREATE_FILES_SYSTEM_SKILL.markdown, /provider result contains `exportCandidate`/);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /Never use `exportCandidate`, `preview\.exportOfferId`/);
    assert.equal(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.aliases.includes('export data'), false);
    assert.match(sheets.markdown, /Before generic web search/);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /`exportCandidate`/);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /`op=plan`/);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /one short offer/);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /returned no candidate/);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /Airtable MCP is not a bulk-export source/);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /Queued is not finished/);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /Never start personal Google OAuth/);
  });

  it('teaches the exact Airtable gateway envelope and native record-read shapes', () => {
    assert.match(airtableCoreSkill.instructions, /root `op: "tools\.invoke"`/);
    assert.match(airtableCoreSkill.instructions, /Put `connectionId` inside `payload\.args`, never beside `payload`/);
    assert.match(airtableCoreSkill.instructions, /toolId: "airtableRecords"/);
    assert.match(airtableSchemaOpsSkill.instructions, /toolId: "airtableSchema"/);
    assert.match(airtableAutomationOpsSkill.instructions, /toolId: "airtableAutomation"/);
    assert.doesNotMatch(airtableSchemaOpsSkill.instructions, /toolId: "airtableRecords", args: \{ op: "describe"\|"call"/);
    assert.doesNotMatch(airtableAutomationOpsSkill.instructions, /toolId: "airtableRecords", args: \{ op: "describe"\|"call"/);
    assert.match(airtableCoreSkill.instructions, /list_records_for_table input uses `filters` plural, not `filter`/);
    assert.match(airtableCoreSkill.instructions, /search_records has a different input shape/);
    assert.match(airtableCoreSkill.instructions, /Never pass `tableId`, `fieldIds`, `filter`, or `pageSize` to search_records/);
    assert.match(airtableCoreSkill.instructions, /Each leaf condition is `\{ operator, operands: \[fieldId, value\] \}`/);
    assert.match(airtableCoreSkill.instructions, /prefer the choice ID from get_table_schema \(`sel\.\.\.`\) over the choice name/);
    assert.match(airtableCoreSkill.instructions, /never use `contains` on free text/);
    assert.match(airtableCoreSkill.instructions, /a product-name prompt resolves against `Product Name`/);
  });

  it('pins a fixed month to exact date bounds instead of a relative Airtable window', () => {
    // The live regression: a July question filtered with `pastMonth` answered a
    // rolling 30-day window and reported a total that was never July's.
    assert.match(airtableCoreSkill.instructions, /A date operand is never a bare date string/);
    assert.match(
      airtableCoreSkill.instructions,
      /`\{ mode: "exactDate", exactDate: "2026-07-01", timeZone: "Asia\/Kolkata" \}`/,
    );
    assert.match(airtableCoreSkill.instructions, /`timeZone` is always required/);
    assert.match(airtableCoreSkill.instructions, /isWithin takes a date RANGE object instead/);
    assert.match(
      airtableCoreSkill.instructions,
      /express it as two exactDate comparisons.*never substitute a relative mode/s,
    );
    assert.match(
      airtableCoreSkill.instructions,
      /`pastMonth` is a rolling window ending today, not a calendar month/,
    );
    assert.match(
      airtableCoreSkill.instructions,
      /`Order Date` >= 2026-07-01 and < 2026-08-01 — never `pastMonth`/,
    );
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /never a relative window such as `pastMonth` or `thisCalendarMonth`/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Carry the member's exact requested window into that filter/);
  });

  it('answers Airtable counts from totalRecordCount and forbids sampling the preview', () => {
    assert.match(
      airtableCoreSkill.instructions,
      /Record reads return a small preview and never a continuation cursor/,
    );
    assert.match(airtableCoreSkill.instructions, /never send `offset` or `cursor`/);
    assert.match(
      airtableCoreSkill.instructions,
      /`metadata\.totalRecordCount`, which is the server's exact count of every record matching the filter/,
    );
    assert.match(airtableCoreSkill.instructions, /Send `pageSize: 1` when only the count is wanted/);
    assert.match(
      airtableCoreSkill.instructions,
      /run one more filtered read per bucket and read each totalRecordCount/,
    );
    assert.match(
      airtableCoreSkill.instructions,
      /When `hasMore` is true the returned rows are a preview, not a sample/,
    );
    assert.match(
      airtableCoreSkill.instructions,
      /Never derive a distribution, share, percentage, average, minimum, maximum, date range, or sum from them/,
    );
    assert.match(
      airtableCoreSkill.instructions,
      /Sums — units, quantity, amount — cannot be computed through this lane at all/,
    );
    assert.match(airtableCoreSkill.instructions, /Call what totalRecordCount returns "order lines" or "records", not orders/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Read the count from Airtable's `metadata\.totalRecordCount`/);
  });

  it('keeps Semrush and OMS on Divo governed candidates without ad-hoc export paths', () => {
    for (const skill of [DIVO_SEMRUSH_SYSTEM_SKILL, DIVO_OMS_SITE_DATA_SYSTEM_SKILL]) {
      assert.match(skill.markdown, /exportCandidate/);
      assert.match(skill.markdown, /op=plan/);
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

  /*
   * Every fact below is already stated by the registered `dataExport` tool —
   * in its zod schema, its description, or its parameterDocs — which is the
   * channel the provider constrains generation against. A second copy in the
   * skill is a weaker one that drifts from the constants the worker enforces,
   * and each of these was in the skill until this rewrite. Guard, or they come
   * back one failed run at a time.
   */
  it('leaves the dataExport contract to the dataExport tool', () => {
    const md = DATA_EXPORT_SYSTEM_SKILL.markdown;
    assert.doesNotMatch(md, /transform\.script|receives `?row`?, `?index`?/i);
    assert.doesNotMatch(md, /destination\.format|format="?(google_sheet|xlsx|csv)"?/i);
    assert.doesNotMatch(md, /\b\d{1,3},?\d{3}\s*(rows|cells)/);
    assert.doesNotMatch(md, /backend re-checks/i);
    assert.doesNotMatch(md, /preview\.exportOfferId|op=confirm/);
    // The Menhood spool cap is the one limit the tool does not publish, so the
    // skill states it — and states it from the constant. A literal number would
    // satisfy /\d+ MB/ while being exactly the drift this test exists to stop.
    assert.ok(md.includes(`spool exceeds ${DATA_EXPORT_MENHOOD_SPOOL_MB_LIMIT} MB`));
  });

  /*
   * Ask/stop conditions, restored after a cold review found the rewrite had
   * dropped both. Neither is deducible from the typed contract: `dataExport`
   * documents what the arguments mean, never that Divo should stop and ask
   * rather than choose. A plan has no `auto` format, so a silent choice here is
   * a silent choice of row cap.
   */
  it('keeps the export specialist asking instead of guessing', () => {
    const md = DATA_EXPORT_SYSTEM_SKILL.markdown;
    assert.match(md, /without naming a format[\s\S]{0,60}ask which/i);
    assert.match(md, /never named[\s\S]{0,80}ask one short question/i);
    // A terminal `op=plan` outcome — a revoked grant, a stale candidate —
    // produces no completion card, so the stop rule cannot key on the card.
    assert.match(md, /`dataExport` itself or the card\s+names a\s+permanent problem/);
  });

  /*
   * Plan §8 Wave 1 requires the legacy compatibility boundary to survive until
   * E2E evidence permits its removal. The handle is still read at runtime by
   * the gateway dispatcher, so the router must keep sending it to its owning
   * specialist rather than letting it be rebuilt as a modern candidate.
   */
  it('keeps the legacy export offer handle routed', () => {
    const data = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'data-router')!;
    assert.match(data.markdown, /`preview\.exportOfferId`/);
    assert.match(data.markdown, /Never rebuild one as an `exportCandidate`/);
  });

  it('keeps each router target list non-empty, unique, and free of self-links', () => {
    for (const seed of SYSTEM_SKILL_ROUTE_SEEDS) {
      assert.ok(seed.targetSlugs.length > 0, `${seed.routerSlug} has no targets`);
      assert.equal(new Set(seed.targetSlugs).size, seed.targetSlugs.length);
      assert.equal(seed.targetSlugs.includes(seed.routerSlug), false);
    }
  });
});
