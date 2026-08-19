import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nativeSkillBinding } from '../../src/application/skills/native-skill-binding.ts';
import type { PermissionResult } from '../../src/application/permissions/permission.types.ts';
import { asToolId } from '../../src/shared/ids.ts';

function permission(
  tools: readonly string[] = ['zohoBooks'],
  actions: readonly string[] = ['read'],
): PermissionResult {
  return {
    allowedToolIds: new Set(tools.map(asToolId)),
    allowedActionsByTool: new Map(tools.map(toolId => [
      asToolId(toolId),
      new Set(actions) as never,
    ])),
    decisions: [],
  };
}

const base = {
  companyId: 'company-1',
  userId: 'user-1',
  departmentId: 'department-1',
  channel: 'lark',
  registryRevision: 9,
  permission: permission(),
  grantedSkillIds: new Set(['skill-2', 'skill-1']),
};

describe('nativeSkillBinding', () => {
  it('is stable across set insertion order', () => {
    const reordered = {
      ...base,
      permission: permission(['zohoBooks']),
      grantedSkillIds: new Set(['skill-1', 'skill-2']),
    };
    assert.equal(nativeSkillBinding(base), nativeSkillBinding(reordered));
  });

  it('changes for every scope and authority input that can change the bundle', () => {
    const binding = nativeSkillBinding(base);
    for (const changed of [
      { ...base, companyId: 'company-2' },
      { ...base, userId: 'user-2' },
      { ...base, departmentId: 'department-2' },
      { ...base, channel: 'web' },
      { ...base, registryRevision: 10 },
      { ...base, permission: permission([]) },
      { ...base, permission: permission(['zohoBooks'], ['read', 'create']) },
      { ...base, grantedSkillIds: new Set(['skill-1']) },
    ]) {
      assert.notEqual(nativeSkillBinding(changed), binding);
    }
  });
});
