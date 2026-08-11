import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { DIVO_SEMRUSH_SYSTEM_SKILL } from '../../src/application/skills/semrush-system-skill.ts';
import { DIVO_OMS_SITE_DATA_SYSTEM_SKILL } from '../../src/application/skills/oms-site-data-system-skill.ts';
import {
  airtableAutomationOpsSkill,
  airtableCoreSkill,
  airtableSchemaOpsSkill,
} from '../../src/application/skills/airtable.skill.ts';
import { MENHOOD_DATA_SYSTEM_SKILL } from '../../src/application/skills/menhood-data-system-skill.ts';
import { shopifySkills } from '../../src/application/skills/shopify.skill.ts';
import { aitableSkills } from '../../src/application/skills/aitable.skill.ts';
import { zohoBooksReadAnalysisSkill } from '../../src/application/skills/zoho.skill.ts';
import { DIVO_LOCAL_PYTHON_SYSTEM_SKILL } from '../../src/application/skills/divo-local-python-system-skill.ts';
import { GOOGLE_WORKSPACE_SYSTEM_SKILLS } from '../../src/application/skills/google-workspace-system-skills.ts';
import { DIVO_PRESENTATIONS_SYSTEM_SKILL } from '../../src/application/skills/divo-presentations-system-skill.ts';
import { ZOHO_FINANCE_SYSTEM_SKILLS } from '../../src/application/skills/zoho-finance-system-skills.ts';
import { LARK_SYSTEM_SKILLS } from '../../src/application/skills/lark-system-skills.ts';
import { MAIL_OPS_SYSTEM_SKILLS } from '../../src/application/skills/mail-ops-system-skills.ts';
import { SCHEDULE_DIVO_WORK_SKILL_MARKDOWN } from '../../src/application/skills/scheduled-work-system-skill.ts';
import { KNOWLEDGE_MANAGEMENT_SKILL_MARKDOWN } from '../../src/application/skills/knowledge-system-skill.ts';
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

  it('gives Menhood live exports one lifecycle without local-file detours', () => {
    const router = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'airtable-router')!;

    assert.match(router.markdown, /Menhood live\/export lifecycle/);
    assert.match(router.markdown, /hydrated quoted message or\s+card text/s);
    assert.match(router.markdown, /Settled historical answer in chat: load `menhood-data` and stop there/);
    assert.match(router.markdown, /Current\/live answer: use `menhood-data` only to resolve a named product's\s+canonical SKU/s);
    assert.match(router.markdown, /Current\/live export or Google Sheet: load `airtable-core`,\s+`divo-python-automation`, and `google-sheets`/s);
    assert.match(router.markdown, /Page the filtered live\s+Airtable source in one local workflow, write the governed Sheet destination,\s+and read it back/s);
    assert.match(router.markdown, /sale totals include customer-requested add-on rows/);
    assert.match(router.markdown, /Add New Item or Added New Item along with Regular\s+Order/);
    assert.match(router.markdown, /reship\/RSP delivered variants/);
    assert.match(router.markdown, /Do not load `create-edit-files` for Lark or Google Sheets delivery/);
    assert.doesNotMatch(router.markdown, /secure-data-export/);
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

  it('keeps direct Airtable reads bounded while using one native contract for file-backed pages', () => {
    assert.match(airtableCoreSkill.instructions, /Ordinary direct `op: "call"` record reads return a byte-safe preview/);
    assert.doesNotMatch(airtableCoreSkill.instructions, /`op: "page"`/);
    assert.match(airtableCoreSkill.instructions, /exact same native `op: "call"` through `divo-local`/);
    assert.match(airtableCoreSkill.instructions, /Pass each returned cursor into the next call/);
    assert.match(airtableCoreSkill.instructions, /`metadata\.totalRecordCount`/);
    assert.match(airtableCoreSkill.instructions, /values under `cellValuesByFieldId`, not `fields`/);
    assert.match(airtableCoreSkill.instructions, /Never derive a distribution, share, percentage, average, minimum, maximum, date range, or sum/);
  });

  it('pins fixed months to exact Airtable date bounds', () => {
    assert.match(airtableCoreSkill.instructions, /A date operand is never a bare date string/);
    assert.match(airtableCoreSkill.instructions, /`timeZone` is always required/);
    assert.match(airtableCoreSkill.instructions, /`pastMonth` is a rolling window ending today, not a calendar month/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /never replace a named month with a rolling window/);
  });

  it('keeps Semrush and OMS truthful about bounded provider coverage', () => {
    for (const skill of [DIVO_SEMRUSH_SYSTEM_SKILL, DIVO_OMS_SITE_DATA_SYSTEM_SKILL]) {
      assert.doesNotMatch(skill.markdown, /exportCandidate|dataExport|cloudinary/i);
    }
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /receives every row Semrush returned for that one\s+bounded report/s);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /do not invent\s+pagination/s);
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

  /*
   * divo_gateway was the mega-tool every provider skill was written against:
   * root `op: "tools.invoke"` wrapping `payload: { toolId, args }`, with
   * `call_tool` as the server-channel variant. It is deleted, and each family
   * is a registered typed tool, so that envelope is now rejected rather than
   * merely redundant — a skill still teaching it describes a call that cannot
   * succeed. Airtable, Shopify and AITable each carried it well past the
   * migration because nothing failed when a skill went stale.
   */
  /*
   * Hand-listed bodies are how the scheduler kept its dead gateway protocol:
   * a family missing from the list is exempt from the only check that would
   * notice. Zoho, Lark, mail-ops and the scheduler were all absent. Build the
   * list from the seeded collections so a new family is covered by existing.
   */
  it('never teaches a call surface the runtime removed', () => {
    const bodies = [
      ...ROUTING_SYSTEM_SKILLS.map(skill => skill.markdown),
      ...shopifySkills.map(skill => skill.instructions),
      ...aitableSkills.map(skill => skill.instructions),
      airtableCoreSkill.instructions,
      airtableSchemaOpsSkill.instructions,
      airtableAutomationOpsSkill.instructions,
      DIVO_SEMRUSH_SYSTEM_SKILL.markdown,
      MENHOOD_DATA_SYSTEM_SKILL.markdown,
      DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown,
      ...GOOGLE_WORKSPACE_SYSTEM_SKILLS.map(skill => skill.markdown),
      ...ZOHO_FINANCE_SYSTEM_SKILLS.map(skill => skill.markdown),
      ...LARK_SYSTEM_SKILLS.map(skill => skill.markdown),
      ...MAIL_OPS_SYSTEM_SKILLS.map(skill => skill.markdown),
      SCHEDULE_DIVO_WORK_SKILL_MARKDOWN,
      KNOWLEDGE_MANAGEMENT_SKILL_MARKDOWN,
    ];
    for (const body of bodies) {
      assert.doesNotMatch(body, /divo_gateway|call_tool|tools\.invoke|payload\.args/);
    }
    /*
     * `tools.preflight` and `tools.list` are internal gateway ops. Pi exposes
     * the first as the typed tool `divo_preflight` and never exposed the
     * second, so two Google skills were naming a call the model cannot make.
     * The op survives inside the backend, which is why the gateway sweep did
     * not catch it — the name is real, just not model-facing.
     */
    for (const skill of GOOGLE_WORKSPACE_SYSTEM_SKILLS) {
      assert.doesNotMatch(skill.markdown, /tools\.preflight|tools\.list/, skill.slug);
    }
    const gmail = GOOGLE_WORKSPACE_SYSTEM_SKILLS.find(skill => skill.slug === 'google-gmail')!;
    assert.match(gmail.markdown, /call `divo_preflight` once/);
  });

  /*
   * The guard above covers skills, which is where the envelope was swept from
   * — and `scheduledWorkflows` still opened its parameterDocs with "Gateway
   * invocation: tools.invoke payload must be { toolId, args }". Tool docs are
   * model-facing copy exactly like a skill body, so a check that skips them
   * misses the layer with the strongest claim on the model's attention.
   */
  it('keeps the removed call surface out of tool documentation too', async () => {
    const dir = new URL('../../src/application/tools/families/', import.meta.url);
    const files = (await readdir(dir)).filter(name => name.endsWith('.ts'));
    assert.ok(files.length > 10, 'expected the tool families directory');
    for (const file of files) {
      const source = await readFile(new URL(file, dir), 'utf8');
      assert.doesNotMatch(source, /divo_gateway|tools\.invoke|Gateway invocation/, file);
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
