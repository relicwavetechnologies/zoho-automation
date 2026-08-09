import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDesktopCapabilityBootstrap } from '../../src/application/desktop/desktop-capability-bootstrap';
import {
  GOVERNED_DIRECT_ACTION_CRITERION,
  GOVERNED_LOCAL_AVAILABLE_RUNTIME,
  GOVERNED_LOCAL_WORKFLOW_CRITERION,
} from '../../src/application/skills/governed-local-routing';
import { GOOGLE_WORKSPACE_SYSTEM_SKILLS } from '../../src/application/skills/google-workspace-system-skills';
import { LARK_SYSTEM_SKILLS } from '../../src/application/skills/lark-system-skills';
import { DIVO_LOCAL_PYTHON_SYSTEM_SKILL } from '../../src/application/skills/divo-local-python-system-skill';
import { DATA_EXPORT_SYSTEM_SKILL } from '../../src/application/skills/data-export-system-skill';
import { ROUTING_SYSTEM_SKILLS } from '../../src/application/skills/system-skill-routes';
import { DIVO_PRESENTATIONS_SYSTEM_SKILL } from '../../src/application/skills/divo-presentations-system-skill';
import {
  zohoBooksInvoiceSkill,
  zohoBillNotifyAccountsSkill,
  zohoBooksBillSkill,
  zohoBooksReadAnalysisSkill,
} from '../../src/application/skills/zoho.skill';

const permission = {
  allowedToolIds: new Set(['googleGmail', 'googleSheets']),
  allowedActionsByTool: new Map([
    ['googleGmail', new Set(['read'])],
    ['googleSheets', new Set(['create'])],
  ]),
  decisions: [],
  department: { roleSlug: 'MEMBER' },
} as any;

describe('governed local-workflow instruction contract', () => {
  it('keeps every desktop-published connected-work recipe on one routing boundary', () => {
    const publishedDesktopRecipes = [
      DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown,
      DIVO_PRESENTATIONS_SYSTEM_SKILL.markdown,
      ...GOOGLE_WORKSPACE_SYSTEM_SKILLS.map((skill) => skill.markdown),
      ...LARK_SYSTEM_SKILLS.map((skill) => skill.markdown),
    ];

    for (const recipe of publishedDesktopRecipes) {
      assert.match(recipe, new RegExp(GOVERNED_DIRECT_ACTION_CRITERION));
      assert.match(recipe, new RegExp(GOVERNED_LOCAL_WORKFLOW_CRITERION));
    }
  });

  it('keeps the capability bootstrap aligned with the published local-workflow criterion', () => {
    const bootstrap = buildDesktopCapabilityBootstrap({
      departmentName: 'Operations',
      departmentSlug: 'operations',
      companyRole: 'MEMBER',
      permission,
      visibleSkills: [{
        id: 'divo-python-automation-id',
        slug: 'divo-python-automation',
        name: 'Divo Local Python Workflows',
        description: 'Persistent governed data workflows.',
        instructions: 'Hidden full recipe.',
        toolIds: [], aliases: [], tags: [], revision: 1,
      }],
      registryRevision: 1,
    });

    assert(bootstrap.routingHints.some((hint) =>
      hint.includes(GOVERNED_LOCAL_WORKFLOW_CRITERION)),
    );
  });

  it('keeps Zoho skills aligned with backend-owned connection selection', () => {
    for (const skill of [
      zohoBooksInvoiceSkill,
      zohoBooksReadAnalysisSkill,
      zohoBooksBillSkill,
      zohoBillNotifyAccountsSkill,
    ]) {
      assert.match(skill.instructions, /Otherwise omit it: the backend selects an account only when exactly one accessible account qualifies/);
      assert.doesNotMatch(skill.instructions, /Before every Zoho action, use connections\.list|Divo never auto-selects a Zoho account/);
    }
  });

  it('documents the exact Zoho terminal result shape instead of inviting schema probes', () => {
    assert.match(zohoBooksReadAnalysisSkill.instructions, /data\.preview\.rows/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /data\.report\.returnedCount/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /data\.hasMore.*data\.nextPage/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /Never count keys in `data` as records/i);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /matching registered Divo Zoho tool/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /source recipe's exact toolId/);
  });

  it('routes exact whole-account finance aggregates through complete governed sources', () => {
    assert.match(zohoBooksReadAnalysisSkill.instructions, /Exact whole-account, complete artifact, or potentially large aggregate/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /keep the direct model preview bounded/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /fetch pages through `divo-local` into one local JSONL\/Parquet file/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /Number\(_balance_inr\) > 0/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /outstanding_payable_amount or outstanding_receivable_amount from get_contact/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /reconcile it: every source page accounted for/);
  });

  it('keeps divo-local availability explicit in published connected-work skills', () => {
    const publishedInstructions = [
      zohoBooksInvoiceSkill.instructions,
      zohoBooksReadAnalysisSkill.instructions,
      zohoBooksBillSkill.instructions,
      zohoBillNotifyAccountsSkill.instructions,
      ...GOOGLE_WORKSPACE_SYSTEM_SKILLS.map((skill) => skill.markdown),
    ];

    for (const text of publishedInstructions) {
      for (const line of text.split('\n')) {
        if (!line.includes('divo-local')) continue;
        assert.match(
          line,
          new RegExp(GOVERNED_LOCAL_AVAILABLE_RUNTIME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          `unqualified divo-local instruction: ${line}`,
        );
      }
    }
  });

  it('routes complete Zoho Books work through cloud-capable governed Python', () => {
    assert.match(zohoBooksReadAnalysisSkill.instructions, /load `divo-python-automation`/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /each returned `nextPage`/);
    assert.doesNotMatch(zohoBooksReadAnalysisSkill.instructions, /server channels there is no divo-local/);
    assert.doesNotMatch(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /divo_skill_view/);
  });

  it('uses native Python for paged sources and keeps candidates as compatibility only', () => {
    const dataRouter = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'data-router')!;
    assert.match(dataRouter.markdown, /exportCandidate/);
    assert.match(dataRouter.markdown, /Complete Zoho Books or CRM artifact/);
    assert.match(dataRouter.markdown, /temporary compatibility route/);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /source skill exposes real page or\s+continuation fields/);
    assert.doesNotMatch(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /how data of any size is processed/);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /supported source tools return bounded chat evidence plus an\s+`exportCandidate`/s);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /`op=plan`/i);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /Use a direct `dataExport` recipe only.*backend-replayable source/s);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /Airtable MCP is not\s+a bulk-export source/s);
  });
});
