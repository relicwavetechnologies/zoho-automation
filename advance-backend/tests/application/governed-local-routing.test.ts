import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDesktopCapabilityBootstrap } from '../../src/application/desktop/desktop-capability-bootstrap';
import {
  GOVERNED_DIRECT_ACTION_CRITERION,
  GOVERNED_LOCAL_WORKFLOW_CRITERION,
} from '../../src/application/skills/governed-local-routing';
import { GOOGLE_WORKSPACE_SYSTEM_SKILLS } from '../../src/application/skills/google-workspace-system-skills';
import { LARK_SYSTEM_SKILLS } from '../../src/application/skills/lark-system-skills';
import { DIVO_LOCAL_PYTHON_SYSTEM_SKILL } from '../../src/application/skills/divo-local-python-system-skill';
import { DATA_EXPORT_SYSTEM_SKILL } from '../../src/application/skills/data-export-system-skill';
import { ROUTING_SYSTEM_SKILLS } from '../../src/application/skills/system-skill-routes';
import { DIVO_PRESENTATIONS_SYSTEM_SKILL } from '../../src/application/skills/divo-presentations-system-skill';
import {
  financeOpsCoreSkill,
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
      financeOpsCoreSkill,
      zohoBooksReadAnalysisSkill,
      zohoBooksBillSkill,
      zohoBillNotifyAccountsSkill,
    ]) {
      assert.match(skill.instructions, /Otherwise omit it: the backend selects an account only when exactly one accessible account qualifies/);
      assert.doesNotMatch(skill.instructions, /Before every Zoho action, use connections\.list|Divo never auto-selects a Zoho account/);
    }
  });

  it('routes exact whole-account finance aggregates through complete governed sources', () => {
    assert.match(zohoBooksReadAnalysisSkill.instructions, /Exact whole-account or potentially large aggregate -> use the scripted workflow/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /omit the limit argument unless the user explicitly requested a numeric maximum/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /When a list result is truncated, do not retry with a larger limit/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /Number\(_balance_inr\) > 0/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /reconcile it: every source page accounted for/);
  });

  it('keeps one-source export offers out of the local Python path', () => {
    const dataRouter = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'data-router')!;
    assert.match(dataRouter.markdown, /preview\.exportOfferId/);
    assert.match(dataRouter.markdown, /more than one connected product/);
    assert.doesNotMatch(dataRouter.markdown, /whatever the row count/);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /governed provider preview and export-offer path/);
    assert.doesNotMatch(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /how data of any size is processed/);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /source result containing `preview\.exportOfferId` already creates/);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /ask a second export question, load or call `dataExport` for that offer/i);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /Use a direct Airtable or Zoho Books\s+recipe only/);
  });
});
