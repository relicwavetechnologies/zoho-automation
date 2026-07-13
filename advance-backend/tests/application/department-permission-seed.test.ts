import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { memberTemplateGrants } from '../../src/application/departments/department-admin.service.ts';
import {
  TOOL_DEFAULT_PERMISSIONS,
  TOOL_SUPPORTED_ACTIONS,
  type CanonicalToolId,
} from '../../src/domain/tools/tool-id.ts';
import { isFixedToolPolicy } from '../../src/domain/tools/tool-policy.ts';

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

    assert.ok(keys.has('dataProcessor:read'));
    assert.ok(!keys.has('larkBase:read'));
    assert.ok(!keys.has('larkApproval:read'));
  });
});
