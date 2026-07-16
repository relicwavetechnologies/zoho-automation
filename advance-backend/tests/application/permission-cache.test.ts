import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionCache } from '../../src/application/permissions/permission.cache';
import { TOOL_PERMISSION_POLICY_REVISION } from '../../src/domain/tools/tool-id';
import { ok } from '../../src/shared/result';

describe('PermissionCache policy versioning', () => {
  it('namespaces company and department snapshots by the canonical tool policy revision', async () => {
    const gets: string[] = [];
    const cache = {
      get: async (key: string) => { gets.push(key); return ok(null); },
      set: async () => ok(undefined),
      setNx: async () => ok(true),
      del: async () => ok(undefined),
      scanDel: async () => ok(0),
    } as any;
    const permissionCache = new PermissionCache(cache);

    await permissionCache.getCompany('co-1', 'COMPANY_ADMIN');
    await permissionCache.getDept('co-1', 'dep-1', 'user-1', 'COMPANY_ADMIN');

    assert.deepEqual(gets, [
      `perm:co:co-1:policy:${TOOL_PERMISSION_POLICY_REVISION}:role:COMPANY_ADMIN`,
      `perm:dep:co-1:dep-1:user-1:COMPANY_ADMIN:policy:${TOOL_PERMISSION_POLICY_REVISION}`,
    ]);
    assert.match(TOOL_PERMISSION_POLICY_REVISION, /^[a-f0-9]{16}$/);
  });
});
