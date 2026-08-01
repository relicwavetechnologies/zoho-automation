import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { memberTemplateGrants } from '../../src/application/departments/department-admin.service.ts';
import {
  TOOL_DEFAULT_PERMISSIONS,
  TOOL_SUPPORTED_ACTIONS,
  type CanonicalToolId,
} from '../../src/domain/tools/tool-id.ts';
import {
  DEPARTMENT_COMPANY_INHERITED_TOOLS,
  DEPARTMENT_GRANT_ONLY_TOOLS,
  isDepartmentGrantOnlyTool,
  isFixedToolPolicy,
} from '../../src/domain/tools/tool-policy.ts';

describe('memberTemplateGrants', () => {
  it('includes only MEMBER-enabled tools and all of their supported actions', () => {
    const grants = memberTemplateGrants();
    const keys = new Set(grants.map((g) => `${g.toolId}:${g.actionGroup}`));

    for (const [toolId, defaults] of Object.entries(TOOL_DEFAULT_PERMISSIONS)) {
      const actions = TOOL_SUPPORTED_ACTIONS[toolId as CanonicalToolId];
      if (isFixedToolPolicy(toolId)) {
        for (const action of actions) {
          assert.ok(!keys.has(`${toolId}:${action}`), `fixed-policy tool must not be seeded: ${toolId}:${action}`);
        }
        continue;
      }
      // A permissive MEMBER default on these is a ceiling, not a grant: they
      // exist to be grantable at all, and seeding them here would hand them to
      // every new role matrix.
      if (isDepartmentGrantOnlyTool(toolId)) {
        for (const action of actions) {
          assert.ok(!keys.has(`${toolId}:${action}`), `department-grant-only tool must not be seeded: ${toolId}:${action}`);
        }
        continue;
      }
      // These capabilities inherit their single company-level RBAC decision.
      // Duplicating them into every department role would create a second,
      // stale authority for the same access decision.
      if (DEPARTMENT_COMPANY_INHERITED_TOOLS.includes(toolId as CanonicalToolId)) {
        for (const action of actions) {
          assert.ok(!keys.has(`${toolId}:${action}`), `company-inherited tool must not be seeded: ${toolId}:${action}`);
        }
        continue;
      }
      if (defaults.MEMBER) {
        for (const action of actions) {
          assert.ok(keys.has(`${toolId}:${action}`), `expected grant ${toolId}:${action}`);
        }
      } else {
        for (const action of actions) {
          assert.ok(!keys.has(`${toolId}:${action}`), `must not grant ${toolId}:${action}`);
        }
      }
    }

    assert.ok(keys.has('dataExport:create'));
    assert.ok(!keys.has('larkBase:read'));
    assert.ok(!keys.has('larkApproval:read'));
  });

  it('keeps every department-grant-only tool out of the template', () => {
    const keys = new Set(memberTemplateGrants().map((g) => `${g.toolId}:${g.actionGroup}`));
    assert.ok(DEPARTMENT_GRANT_ONLY_TOOLS.length > 0, 'this guard is pointless if the list is empty');
    for (const toolId of DEPARTMENT_GRANT_ONLY_TOOLS) {
      for (const action of TOOL_SUPPORTED_ACTIONS[toolId]) {
        assert.ok(!keys.has(`${toolId}:${action}`), `${toolId}:${action} leaked into the MEMBER template`);
      }
    }
  });
});
