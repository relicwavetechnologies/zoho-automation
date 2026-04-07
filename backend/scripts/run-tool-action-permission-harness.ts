import assert from 'node:assert/strict';

import { aiRoleService } from '../src/company/tools/ai-role.service';
import type { ToolActionGroup } from '../src/company/tools/tool-action-groups';
import { ToolPermissionService } from '../src/company/tools/tool-permission.service';
import { toolAccessCache } from '../src/company/tools/tool-access.cache';
import { ensureActionPermission } from '../src/company/orchestration/vercel/runtime-tools';
import { __test__ as orchestrationEngineTest } from '../src/company/orchestration/engine/vercel-orchestration.engine';

type ActionRow = {
  companyId: string;
  toolId: string;
  role: string;
  actionGroup: string;
  enabled: boolean;
  updatedBy?: string | null;
};

const actionRows: ActionRow[] = [];
let actionQueryCount = 0;
let cacheHits = 0;
const actionCache = new Map<string, Record<string, string[]>>();

const originalListRoles = aiRoleService.listRoles.bind(aiRoleService);
const originalGetRoleSlugs = aiRoleService.getRoleSlugs.bind(aiRoleService);
const originalGetAllowedActions = toolAccessCache.getAllowedActions.bind(toolAccessCache);
const originalSetAllowedActions = toolAccessCache.setAllowedActions.bind(toolAccessCache);
const originalInvalidateCompany = toolAccessCache.invalidateCompany.bind(toolAccessCache);

(aiRoleService as any).listRoles = async () => [
  { id: 'role_member', slug: 'MEMBER', displayName: 'Member', isBuiltIn: true },
  { id: 'role_admin', slug: 'COMPANY_ADMIN', displayName: 'Company Admin', isBuiltIn: true },
];
(aiRoleService as any).getRoleSlugs = async () => ['MEMBER', 'COMPANY_ADMIN'];

(toolAccessCache as any).getAllowedActions = async (companyId: string, role: string) => {
  const key = `${companyId}:${role}`;
  const cached = actionCache.get(key) ?? null;
  if (cached) {
    cacheHits += 1;
  }
  return cached;
};
(toolAccessCache as any).setAllowedActions = async (
  companyId: string,
  role: string,
  data: Record<string, string[]>,
) => {
  actionCache.set(`${companyId}:${role}`, data);
};
(toolAccessCache as any).invalidateCompany = async (companyId: string) => {
  for (const key of [...actionCache.keys()]) {
    if (key.startsWith(`${companyId}:`)) {
      actionCache.delete(key);
    }
  }
};

const service = new ToolPermissionService(
  {
    getForCompany: async () => [],
    upsert: async () => {
      throw new Error('not_used');
    },
  } as any,
  {
    getForCompany: async (companyId: string) => {
      actionQueryCount += 1;
      return actionRows.filter((row) => row.companyId === companyId);
    },
    upsert: async (
      companyId: string,
      toolId: string,
      role: string,
      actionGroup: string,
      enabled: boolean,
      updatedBy?: string,
    ) => {
      const existing = actionRows.find(
        (row) =>
          row.companyId === companyId
          && row.toolId === toolId
          && row.role === role
          && row.actionGroup === actionGroup,
      );
      if (existing) {
        existing.enabled = enabled;
        existing.updatedBy = updatedBy;
        return existing;
      }
      const created = { companyId, toolId, role, actionGroup, enabled, updatedBy };
      actionRows.push(created);
      return created;
    },
  } as any,
);

async function run(): Promise<void> {
  actionRows.length = 0;
  actionCache.clear();
  actionQueryCount = 0;
  cacheHits = 0;

  const noOverride = await service.getAllowedActionsByTool('company_a', 'MEMBER', ['zohoBooks', 'google-gmail']);
  assert.deepEqual(noOverride.zohoBooks, ['read']);
  assert.deepEqual(noOverride['google-gmail'], ['read', 'create', 'send']);

  actionCache.clear();
  actionRows.push({
    companyId: 'company_a',
    toolId: 'coding',
    role: 'MEMBER',
    actionGroup: 'create',
    enabled: false,
    updatedBy: 'tester',
  });
  const codingActions = await service.getAllowedActionsByTool('company_a', 'MEMBER', ['coding']);
  assert.ok(!codingActions.coding.includes('create'));
  assert.ok(codingActions.coding.includes('read'));

  const denied = ensureActionPermission(
    {
      allowedToolIds: ['coding'],
      allowedActionsByTool: {
        coding: ['read', 'update'] satisfies ToolActionGroup[],
      },
    } as any,
    'coding',
    'create',
  );
  assert.ok(denied);
  assert.equal(denied?.errorKind, 'permission');

  const runtimeActions = await orchestrationEngineTest.ensureAllowedActionsByTool({
    companyId: 'company_a',
    requesterAiRole: 'MEMBER',
    allowedToolIds: ['coding'],
    allowedActionsByTool: undefined,
  });
  assert.ok(runtimeActions.coding.length > 0);

  actionCache.clear();
  actionQueryCount = 0;
  cacheHits = 0;
  await service.getAllowedActionsByTool('company_cache', 'MEMBER', ['coding']);
  await service.getAllowedActionsByTool('company_cache', 'MEMBER', ['coding']);
  assert.equal(actionQueryCount, 1);
  assert.equal(cacheHits, 1);

  console.log('tool-action-permission-harness-ok');
}

run()
  .finally(() => {
    (aiRoleService as any).listRoles = originalListRoles;
    (aiRoleService as any).getRoleSlugs = originalGetRoleSlugs;
    (toolAccessCache as any).getAllowedActions = originalGetAllowedActions;
    (toolAccessCache as any).setAllowedActions = originalSetAllowedActions;
    (toolAccessCache as any).invalidateCompany = originalInvalidateCompany;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
