const assert = require('node:assert/strict');
const test = require('node:test');

const { ZohoRoleAccessService } = require('../dist/company/tools/zoho-role-access.service');
const { aiRoleService } = require('../dist/company/tools/ai-role.service');

const withPatch = async (target, methodName, replacement, fn) => {
  const original = target[methodName];
  target[methodName] = replacement;
  try {
    await fn();
  } finally {
    target[methodName] = original;
  }
};

test('ZohoRoleAccessService defaults roles to email scoped', async () => {
  const service = new ZohoRoleAccessService({
    getForCompany: async () => [],
    upsert: async () => {
      throw new Error('should not upsert');
    },
  });

  await withPatch(aiRoleService, 'listRoles', async () => [
    { id: 'r1', slug: 'MEMBER', displayName: 'Member', isBuiltIn: true },
  ], async () => {
    const matrix = await service.getMatrix('cmp-1');
    assert.equal(matrix[0].companyScopedRead, false);
  });
});

test('ZohoRoleAccessService resolves company scope for enabled roles', async () => {
  const service = new ZohoRoleAccessService({
    getForCompany: async () => [{ role: 'COMPANY_ADMIN', companyScopedRead: true }],
    upsert: async () => {
      throw new Error('should not upsert');
    },
  });

  await withPatch(aiRoleService, 'listRoles', async () => [
    { id: 'r1', slug: 'MEMBER', displayName: 'Member', isBuiltIn: true },
    { id: 'r2', slug: 'COMPANY_ADMIN', displayName: 'Company Admin', isBuiltIn: true },
  ], async () => {
    const scopeMode = await service.resolveScopeMode('cmp-1', 'COMPANY_ADMIN');
    assert.equal(scopeMode, 'company_scoped');
  });
});
