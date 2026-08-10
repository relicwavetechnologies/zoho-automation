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
    const recipes = [
      DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown,
      DIVO_PRESENTATIONS_SYSTEM_SKILL.markdown,
      ...GOOGLE_WORKSPACE_SYSTEM_SKILLS.map(skill => skill.markdown),
      ...LARK_SYSTEM_SKILLS.map(skill => skill.markdown),
    ];
    for (const recipe of recipes) {
      assert.match(recipe, new RegExp(GOVERNED_DIRECT_ACTION_CRITERION));
      assert.match(recipe, new RegExp(GOVERNED_LOCAL_WORKFLOW_CRITERION));
    }
  });

  it('keeps capability bootstrap aligned with the local-workflow criterion', () => {
    const bootstrap = buildDesktopCapabilityBootstrap({
      departmentName: 'Operations', departmentSlug: 'operations', companyRole: 'MEMBER', permission,
      visibleSkills: [{
        id: 'divo-python-automation-id', slug: 'divo-python-automation', name: 'Divo Local Python Workflows',
        description: 'Persistent governed data workflows.', instructions: 'Hidden full recipe.',
        toolIds: [], aliases: [], tags: [], revision: 1,
      }],
      registryRevision: 1,
    });
    assert(bootstrap.routingHints.some(hint => hint.includes(GOVERNED_LOCAL_WORKFLOW_CRITERION)));
  });

  /*
   * Both Zoho tools state in parameterDocs how connectionId itself behaves —
   * omit it when one account qualifies, retry with the exact ID an error
   * returns. Six skills repeated that, so the same rule shipped seven times.
   * The skills keep only what a schema cannot say: ask the member when Divo
   * offers choices, stop when nothing is accessible, and never re-discover an
   * account through a different tool.
   */
  it('leaves connectionId selection to the Zoho tools that state it', () => {
    for (const skill of [zohoBooksInvoiceSkill, zohoBooksReadAnalysisSkill, zohoBooksBillSkill, zohoBillNotifyAccountsSkill]) {
      assert.doesNotMatch(skill.instructions, /Before every Zoho action, use connections\.list|Divo never auto-selects a Zoho account/);
      assert.doesNotMatch(skill.instructions, /the backend selects an account only when exactly one/);
      assert.match(skill.instructions, /ask one short account-choice question/);
      assert.match(skill.instructions, /If no connection is accessible, tell the member to connect/);
      assert.match(skill.instructions, /Do not call connections\.list to rediscover an account/);
    }
  });

  it('documents the exact Zoho terminal result shape', () => {
    assert.match(zohoBooksReadAnalysisSkill.instructions, /data\.preview\.rows/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /data\.report\.returnedCount/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /data\.hasMore.*data\.nextPage/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /Never count keys in `data` as records/i);
  });

  it('routes complete Zoho Books artifacts through file-backed terminal paging', () => {
    assert.match(zohoBooksReadAnalysisSkill.instructions, /complete artifact.*local Python workflow/is);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /pass its exact ISO boundaries as `dateFrom` and `dateTo`/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /Never fetch the whole Zoho account and filter it locally/);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /Do not ask whether to proceed/i);
    assert.match(zohoBooksReadAnalysisSkill.instructions, /source, written, and read-back counts/);
  });

  it('qualifies every divo-local instruction with runtime availability', () => {
    const instructions = [
      zohoBooksInvoiceSkill.instructions,
      zohoBooksReadAnalysisSkill.instructions,
      zohoBooksBillSkill.instructions,
      zohoBillNotifyAccountsSkill.instructions,
      ...GOOGLE_WORKSPACE_SYSTEM_SKILLS.map(skill => skill.markdown),
    ];
    const criterion = new RegExp(GOVERNED_LOCAL_AVAILABLE_RUNTIME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    for (const text of instructions) {
      for (const line of text.split('\n')) {
        if (line.includes('divo-local')) assert.match(line, criterion);
      }
    }
  });

  it('uses native Python only when the source has truthful continuation', () => {
    const dataRouter = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'data-router')!;
    assert.match(dataRouter.markdown, /source specialist plus `divo-python-automation`/);
    assert.match(dataRouter.markdown, /source exposes no complete paging\s+contract, say that plainly/s);
    assert.match(DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown, /source skill exposes real page or\s+continuation fields/);
    assert.doesNotMatch(`${dataRouter.markdown}\n${DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown}`, /exportCandidate|dataExport/);
  });
});
