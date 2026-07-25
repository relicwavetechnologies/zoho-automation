import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDesktopCapabilityBootstrap } from '../../src/application/desktop/desktop-capability-bootstrap';
import { googleSkill } from '../../src/application/skills/google.skill';
import {
  GOVERNED_DIRECT_ACTION_CRITERION,
  GOVERNED_LOCAL_WORKFLOW_CRITERION,
} from '../../src/application/skills/governed-local-routing';
import { GOOGLE_WORKSPACE_SYSTEM_SKILLS } from '../../src/application/skills/google-workspace-system-skills';
import { LARK_SYSTEM_SKILLS } from '../../src/application/skills/lark-system-skills';
import { DIVO_LOCAL_PYTHON_SYSTEM_SKILL } from '../../src/application/skills/divo-local-python-system-skill';
import { DIVO_PRESENTATIONS_SYSTEM_SKILL } from '../../src/application/skills/divo-presentations-system-skill';
import {
  financeOpsCoreSkill,
  zohoBillNotifyAccountsSkill,
  zohoBooksBillSkill,
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
      googleSkill.instructions,
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

  it('keeps the vendor planner internal to bounded work resolution', () => {
    assert.doesNotMatch(googleSkill.instructions, /google\.plan/i);
    assert.match(googleSkill.instructions, /explicit multi-product vendor onboarding workflow/i);
    assert.match(googleSkill.instructions, /Do not invoke or search for a raw planning operation yourself/i);
    assert.match(googleSkill.instructions, /never a planner for exports, reports, aggregation, analysis, or a generic Gmail-to-Sheets task/i);
  });

  it('reuses run bootstrap accounts and native contracts without rediscovery', () => {
    assert.match(googleSkill.instructions, /Reuse the exact Google account already returned by the current run bootstrap/i);
    assert.match(googleSkill.instructions, /bootstrap\.nativeContracts/i);
    assert.match(googleSkill.instructions, /connections\.list once only when the bootstrap explicitly says/i);
    assert.doesNotMatch(googleSkill.instructions, /Before any op="call", use connections\.list/i);
    assert.doesNotMatch(googleSkill.instructions, /connectionId may be omitted/i);
  });

  it('keeps Zoho skills aligned with backend-owned connection selection', () => {
    for (const skill of [financeOpsCoreSkill, zohoBooksBillSkill, zohoBillNotifyAccountsSkill]) {
      assert.match(skill.instructions, /Otherwise omit it: the backend selects an account only when exactly one accessible account qualifies/);
      assert.doesNotMatch(skill.instructions, /Before every Zoho action, use connections\.list|Divo never auto-selects a Zoho account/);
    }
  });
});
