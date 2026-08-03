import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CANONICAL_TOOL_IDS,
  TOOL_CAPABILITY_DEFINITIONS,
  TOOL_DEFAULT_PERMISSIONS,
  TOOL_FAMILY_DEFINITIONS,
  TOOL_FAMILY_IDS,
  TOOL_FAMILY_MAP,
  TOOL_SUPPORTED_ACTIONS,
  isToolFamily,
  toolIdsForFamily,
} from '../../src/domain/tools/tool-id';
import { getDesktopToolPolicy, isFixedToolPolicy } from '../../src/domain/tools/tool-policy';

describe('tool capability taxonomy', () => {
  it('derives every public policy view from one complete definition', () => {
    assert.deepEqual(Object.keys(TOOL_CAPABILITY_DEFINITIONS), [...CANONICAL_TOOL_IDS]);
    assert.deepEqual(Object.keys(TOOL_FAMILY_DEFINITIONS), [...TOOL_FAMILY_IDS]);

    for (const toolId of CANONICAL_TOOL_IDS) {
      const definition = TOOL_CAPABILITY_DEFINITIONS[toolId];
      assert.equal(TOOL_FAMILY_MAP[toolId], definition.family);
      assert.deepEqual(TOOL_SUPPORTED_ACTIONS[toolId], definition.supportedActions);
      assert.deepEqual(TOOL_DEFAULT_PERMISSIONS[toolId], definition.defaultPermissions);
      assert(toolIdsForFamily(definition.family).includes(toolId));
    }
  });

  it('recognizes exact family IDs without fuzzy execution aliases', () => {
    for (const family of TOOL_FAMILY_IDS) assert.equal(isToolFamily(family), true);
    assert.equal(isToolFamily('google_workspace'), false);
    assert.equal(isToolFamily('base'), false);
    assert.equal(isToolFamily('air table'), false);
  });

  it('keeps Menhood backend-managed and denied until its Airtable alias is applied', () => {
    assert.deepEqual(TOOL_FAMILY_DEFINITIONS.menhood, {
      displayName: 'Menhood',
      connectionMode: 'backend_managed',
      skillMode: 'optional',
      routingAliases: ['menhood'],
    });
    assert.deepEqual(TOOL_SUPPORTED_ACTIONS.menhoodData, ['read']);
    assert.deepEqual(TOOL_DEFAULT_PERMISSIONS.menhoodData, {
      MEMBER: false,
      COMPANY_ADMIN: false,
      SUPER_ADMIN: false,
    });
    assert.deepEqual(getDesktopToolPolicy('menhoodData'), {
      kind: 'inherited',
      supportedActions: ['read'],
      reason: 'Access follows Airtable Records.',
    });
    assert.equal(isFixedToolPolicy('menhoodData'), true);
  });
});
