import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionServiceImpl } from '../../src/application/permissions/permission.service.ts';
import type { PermissionServiceDeps } from '../../src/application/permissions/permission.service.ts';
import type { CompanyRoleRepoPort } from '../../src/infrastructure/persistence/company-role.repository.ts';
import type { ToolPermissionRepoPort, ToolPermissionRow } from '../../src/infrastructure/persistence/tool-permission.repository.ts';
import type { ToolActionPermissionRepoPort, ToolActionPermissionRow } from '../../src/infrastructure/persistence/tool-action-permission.repository.ts';
import type { DepartmentRepoPort, DepartmentMembershipRow } from '../../src/infrastructure/persistence/department.repository.ts';
import type { DeptToolPermissionRepoPort, DeptToolPermissionRow } from '../../src/infrastructure/persistence/department-tool-permission.repository.ts';
import type { DeptUserOverrideRepoPort, DeptUserOverrideRow } from '../../src/infrastructure/persistence/department-user-override.repository.ts';
import type { CachePort } from '../../src/shared/cache.ts';
import type { Logger } from '../../src/shared/logger.ts';
import { ok } from '../../src/shared/result.ts';
import type { PermissionQuery } from '../../src/application/permissions/permission.types.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const COMPANY_ID = 'co_test_001';
const USER_ID    = 'usr_test_001';
const DEPT_ID    = 'dep_test_001';

const noopLogger: Logger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

/** In-memory cache that correctly implements CachePort (returns Result<T>). */
function makeMemoryCache(): CachePort {
  const store = new Map<string, unknown>();
  return {
    get: async (k) => ok(store.has(k) ? (store.get(k) as any) : null),
    set: async (k, v) => { store.set(k, v); return ok(undefined); },
    del: async (k) => { store.delete(k); return ok(undefined); },
    scanDel: async (pattern) => {
      const prefix = pattern.replace(/\*.*$/, '');
      let count = 0;
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) { store.delete(k); count++; }
      }
      return ok(count);
    },
  };
}

const baseCompanyRoleRepo = (): CompanyRoleRepoPort => ({
  getValidSlugs: async () => ok(['OWNER', 'COMPANY_ADMIN', 'MEMBER']),
  listByCompany: async () => ok([]),
  ensureBuiltIns: async () => ok(undefined),
  upsertCustom: async () => ok({} as any),
  delete: async () => ok(undefined),
});

const emptyToolPermRepo = (): ToolPermissionRepoPort => ({
  getForCompany: async () => ok([]),
  upsert: async () => ok({} as any),
});

const emptyActionPermRepo = (): ToolActionPermissionRepoPort => ({
  getForCompany: async () => ok([]),
  upsert: async () => ok({} as any),
});

const membershipRow = (overrides: Partial<DepartmentMembershipRow> = {}): DepartmentMembershipRow => ({
  userId: USER_ID,
  departmentId: DEPT_ID,
  roleId: 'role_member_001',
  roleSlug: 'MEMBER',
  roleName: 'Member',
  departmentName: 'Engineering',
  departmentCompanyId: COMPANY_ID,
  ...overrides,
});

const emptyDeptToolPermRepo = (): DeptToolPermissionRepoPort => ({
  getForDeptRole: async () => ok([]),
  upsert: async () => ok({} as any),
});

const emptyUserOverrideRepo = (): DeptUserOverrideRepoPort => ({
  getForUser: async () => ok([]),
});

function buildDeps(overrides: Partial<PermissionServiceDeps> = {}): PermissionServiceDeps {
  return {
    companyRoleRepo:     baseCompanyRoleRepo(),
    toolPermRepo:        emptyToolPermRepo(),
    toolActionRepo:      emptyActionPermRepo(),
    deptRepo:            { getMembership: async () => ok(null) },
    deptToolPermRepo:    emptyDeptToolPermRepo(),
    deptUserOverrideRepo: emptyUserOverrideRepo(),
    cache:               makeMemoryCache(),
    logger:              noopLogger,
    ...overrides,
  };
}

const baseQuery = (overrides: Partial<PermissionQuery> = {}): PermissionQuery => ({
  companyId: COMPANY_ID as any,
  userId: USER_ID as any,
  companyRole: 'MEMBER' as any,
  channel: 'lark',
  ...overrides,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PermissionService', () => {

  // ── Company-only: MEMBER defaults ─────────────────────────────────────────

  describe('company-only resolution (no department)', () => {
    it('MEMBER gets default lark tools (messaging, task, calendar, doc) and NOT larkBase/larkApproval', async () => {
      const svc = new PermissionServiceImpl(buildDeps());
      const result = await svc.resolve(baseQuery({ companyRole: 'MEMBER' as any }));

      assert.ok(result.ok);
      const ids = [...result.value.allowedToolIds].map(String);
      assert.ok(ids.includes('larkMessaging'), 'MEMBER should have larkMessaging');
      assert.ok(ids.includes('larkTask'),      'MEMBER should have larkTask');
      assert.ok(ids.includes('larkCalendar'),  'MEMBER should have larkCalendar');
      assert.ok(ids.includes('larkDoc'),       'MEMBER should have larkDoc');
      assert.ok(!ids.includes('larkBase'),     'MEMBER should NOT have larkBase by default');
      assert.ok(!ids.includes('larkApproval'), 'MEMBER should NOT have larkApproval by default');
      assert.ok(!ids.includes('zohoCrm'),      'MEMBER should NOT have zohoCrm by default');
    });

    it('COMPANY_ADMIN gets every tool including larkBase, larkApproval, zoho', async () => {
      const svc = new PermissionServiceImpl(buildDeps());
      const result = await svc.resolve(baseQuery({ companyRole: 'COMPANY_ADMIN' as any }));

      assert.ok(result.ok);
      const ids = [...result.value.allowedToolIds].map(String);
      assert.ok(ids.includes('larkBase'),     'COMPANY_ADMIN should have larkBase');
      assert.ok(ids.includes('larkApproval'), 'COMPANY_ADMIN should have larkApproval');
      assert.ok(ids.includes('zohoCrm'),      'COMPANY_ADMIN should have zohoCrm');
      assert.ok(ids.includes('zohoBooks'),    'COMPANY_ADMIN should have zohoBooks');
    });

    it('SUPER_ADMIN gets every tool', async () => {
      const svc = new PermissionServiceImpl(buildDeps());
      const result = await svc.resolve(baseQuery({ companyRole: 'SUPER_ADMIN' as any }));

      assert.ok(result.ok);
      const ids = [...result.value.allowedToolIds].map(String);
      assert.ok(ids.includes('larkBase'));
      assert.ok(ids.includes('zohoCrm'));
      assert.ok(ids.includes('zohoBooks'));
      assert.ok(ids.includes('larkApproval'));
    });

    it('unknown role returns PermissionError(unknown_role)', async () => {
      const svc = new PermissionServiceImpl(buildDeps());
      const result = await svc.resolve(baseQuery({ companyRole: 'GHOST_ROLE' as any }));

      assert.ok(!result.ok);
      assert.equal(result.error.payload.reason, 'unknown_role');
    });

    it('company override: explicitly disable larkTask for MEMBER', async () => {
      const toolPermRepo: ToolPermissionRepoPort = {
        getForCompany: async () => ok([
          { companyId: COMPANY_ID, toolId: 'larkTask', role: 'MEMBER', enabled: false } as ToolPermissionRow,
        ]),
        upsert: async () => ok({} as any),
      };
      const svc = new PermissionServiceImpl(buildDeps({ toolPermRepo }));
      const result = await svc.resolve(baseQuery({ companyRole: 'MEMBER' as any }));

      assert.ok(result.ok);
      const ids = [...result.value.allowedToolIds].map(String);
      assert.ok(!ids.includes('larkTask'), 'larkTask should be disabled by company override');
    });

    it('action override: disable larkTask:delete for MEMBER, other actions still allowed', async () => {
      const toolActionRepo: ToolActionPermissionRepoPort = {
        getForCompany: async () => ok([
          { companyId: COMPANY_ID, toolId: 'larkTask', role: 'MEMBER', actionGroup: 'delete', enabled: false } as ToolActionPermissionRow,
        ]),
        upsert: async () => ok({} as any),
      };
      const svc = new PermissionServiceImpl(buildDeps({ toolActionRepo }));
      const result = await svc.resolve(baseQuery({ companyRole: 'MEMBER' as any }));

      assert.ok(result.ok);
      const taskActions = [...(result.value.allowedActionsByTool.get('larkTask' as any) ?? [])];
      assert.ok(taskActions.includes('read'),   'read should still be allowed');
      assert.ok(taskActions.includes('create'), 'create should still be allowed');
      assert.ok(!taskActions.includes('delete'), 'delete should be blocked by action override');
    });

    it('custom role resolves using MEMBER defaults', async () => {
      const companyRoleRepo: CompanyRoleRepoPort = {
        ...baseCompanyRoleRepo(),
        getValidSlugs: async () => ok(['OWNER', 'COMPANY_ADMIN', 'MEMBER', 'ANALYST']),
      };
      const svc = new PermissionServiceImpl(buildDeps({ companyRoleRepo }));
      const result = await svc.resolve(baseQuery({ companyRole: 'ANALYST' as any }));

      assert.ok(result.ok);
      const ids = [...result.value.allowedToolIds].map(String);
      assert.ok(ids.includes('larkTask'),  'custom role inherits MEMBER defaults');
      assert.ok(!ids.includes('larkBase'), 'custom role does not get larkBase (not in MEMBER defaults)');
    });
  });

  // ── Cache behaviour ────────────────────────────────────────────────────────

  describe('caching', () => {
    it('second call returns cached result without hitting repos', async () => {
      let callCount = 0;
      const toolPermRepo: ToolPermissionRepoPort = {
        getForCompany: async () => { callCount++; return ok([]); },
        upsert: async () => ok({} as any),
      };
      const svc = new PermissionServiceImpl(buildDeps({ toolPermRepo }));
      const q = baseQuery({ companyRole: 'MEMBER' as any });

      await svc.resolve(q);
      const firstCount = callCount;
      await svc.resolve(q);

      assert.equal(callCount, firstCount, 'repos should not be hit on second call (cache hit)');
    });

    it('invalidateCompany clears cache so next call re-queries repos', async () => {
      let callCount = 0;
      const toolPermRepo: ToolPermissionRepoPort = {
        getForCompany: async () => { callCount++; return ok([]); },
        upsert: async () => ok({} as any),
      };
      const svc = new PermissionServiceImpl(buildDeps({ toolPermRepo }));
      const q = baseQuery({ companyRole: 'MEMBER' as any });

      await svc.resolve(q);
      await svc.invalidateCompany(COMPANY_ID);
      await svc.resolve(q);

      assert.ok(callCount >= 2, 'should re-query after invalidation');
    });
  });

  // ── Department overlay ────────────────────────────────────────────────────

  describe('department overlay', () => {
    it('user not a member of dept returns PermissionError(department_access_denied)', async () => {
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(null) },
      }));
      const result = await svc.resolve(baseQuery({
        companyRole: 'MEMBER' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(!result.ok);
      assert.equal(result.error.payload.reason, 'department_access_denied');
    });

    it('THE CRITICAL BUG CASE: MEMBER + dept MANAGER role → larkTask:create allowed via company_default', async () => {
      // This is the exact bug that the old backend had wrong.
      // The old code passed deptRoleSlug into a company-role lookup, so it always got {}.
      // The new code: company axis resolves larkTask for MEMBER (allowed by default),
      // then the dept overlay finds no explicit permission → falls through to company ceiling → allowed.
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: {
          getMembership: async () => ok(membershipRow({
            roleSlug: 'MANAGER',
            roleId: 'role_mgr_001',
          })),
        },
        deptToolPermRepo: emptyDeptToolPermRepo(),  // no explicit dept perms
        deptUserOverrideRepo: emptyUserOverrideRepo(),
      }));

      const result = await svc.resolve(baseQuery({
        companyRole: 'MEMBER' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok, 'should resolve successfully');
      const taskActions = [...(result.value.allowedActionsByTool.get('larkTask' as any) ?? [])];
      assert.ok(taskActions.includes('create'), 'larkTask:create must be allowed (MEMBER company default)');

      const createDecision = result.value.decisions.find(
        d => String(d.toolId) === 'larkTask' && d.actionGroup === 'create',
      );
      assert.ok(createDecision, 'should have a decision entry for larkTask:create');
      assert.equal(createDecision.source, 'company_default', 'source must be company_default, NOT dept role');
    });

    it('dept-role explicit allow for larkBase but MEMBER ceiling excludes larkBase → blocked', async () => {
      // Dept says larkBase:read = true, but MEMBER company ceiling doesn't allow larkBase at all.
      // The ceiling must block it.
      const deptToolPermRepo: DeptToolPermissionRepoPort = {
        getForDeptRole: async () => ok([
          { departmentId: DEPT_ID, roleId: 'role_001', toolId: 'larkBase', actionGroup: 'read', allowed: true },
        ]),
        upsert: async () => ok({} as any),
      };
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo,
      }));

      const result = await svc.resolve(baseQuery({
        companyRole: 'MEMBER' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      const ids = [...result.value.allowedToolIds].map(String);
      assert.ok(!ids.includes('larkBase'), 'larkBase must be blocked by MEMBER company ceiling despite dept grant');
    });

    it('dept-role explicitly denies larkMessaging → not allowed even though MEMBER defaults allow it', async () => {
      const deptToolPermRepo: DeptToolPermissionRepoPort = {
        getForDeptRole: async () => ok([
          { departmentId: DEPT_ID, roleId: 'role_001', toolId: 'larkMessaging', actionGroup: 'read', allowed: false },
          { departmentId: DEPT_ID, roleId: 'role_001', toolId: 'larkMessaging', actionGroup: 'send', allowed: false },
        ]),
        upsert: async () => ok({} as any),
      };
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo,
      }));

      const result = await svc.resolve(baseQuery({
        companyRole: 'MEMBER' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      const ids = [...result.value.allowedToolIds].map(String);
      assert.ok(!ids.includes('larkMessaging'), 'larkMessaging must be denied by dept-role override');
    });

    it('user-override denies larkTask → not allowed even though MEMBER defaults allow it', async () => {
      const deptUserOverrideRepo: DeptUserOverrideRepoPort = {
        getForUser: async () => ok([
          { departmentId: DEPT_ID, userId: USER_ID, toolId: 'larkTask', actionGroup: 'read',   allowed: false },
          { departmentId: DEPT_ID, userId: USER_ID, toolId: 'larkTask', actionGroup: 'create', allowed: false },
          { departmentId: DEPT_ID, userId: USER_ID, toolId: 'larkTask', actionGroup: 'update', allowed: false },
          { departmentId: DEPT_ID, userId: USER_ID, toolId: 'larkTask', actionGroup: 'delete', allowed: false },
        ]),
      };
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptUserOverrideRepo,
      }));

      const result = await svc.resolve(baseQuery({
        companyRole: 'MEMBER' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      const ids = [...result.value.allowedToolIds].map(String);
      assert.ok(!ids.includes('larkTask'), 'user-override denial must take highest priority');
    });

    it('user-override allows larkTask:create → source is department_user_override', async () => {
      const deptUserOverrideRepo: DeptUserOverrideRepoPort = {
        getForUser: async () => ok([
          { departmentId: DEPT_ID, userId: USER_ID, toolId: 'larkTask', actionGroup: 'create', allowed: true },
        ]),
      };
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptUserOverrideRepo,
      }));

      const result = await svc.resolve(baseQuery({
        companyRole: 'MEMBER' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      const decision = result.value.decisions.find(
        d => String(d.toolId) === 'larkTask' && d.actionGroup === 'create',
      );
      assert.ok(decision);
      assert.equal(decision.source, 'department_user_override');
    });

    it('priority order: user-override beats dept-role when both disagree', async () => {
      // dept-role says larkTask:create = false, user-override says larkTask:create = true
      const deptToolPermRepo: DeptToolPermissionRepoPort = {
        getForDeptRole: async () => ok([
          { departmentId: DEPT_ID, roleId: 'role_001', toolId: 'larkTask', actionGroup: 'create', allowed: false },
        ]),
        upsert: async () => ok({} as any),
      };
      const deptUserOverrideRepo: DeptUserOverrideRepoPort = {
        getForUser: async () => ok([
          { departmentId: DEPT_ID, userId: USER_ID, toolId: 'larkTask', actionGroup: 'create', allowed: true },
        ]),
      };
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo,
        deptUserOverrideRepo,
      }));

      const result = await svc.resolve(baseQuery({
        companyRole: 'MEMBER' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      const decision = result.value.decisions.find(
        d => String(d.toolId) === 'larkTask' && d.actionGroup === 'create',
      );
      assert.ok(decision, 'larkTask:create should be allowed');
      assert.equal(decision.source, 'department_user_override', 'user-override wins over dept-role');
    });

    it('result.department is populated with membership metadata', async () => {
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: {
          getMembership: async () => ok(membershipRow({
            systemPrompt: 'You are a helpful engineering assistant.',
            departmentName: 'Engineering',
          })),
        },
      }));

      const result = await svc.resolve(baseQuery({
        companyRole: 'MEMBER' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      assert.ok(result.value.department, 'department meta should be present');
      assert.equal(result.value.department.name, 'Engineering');
      assert.equal(result.value.department.systemPrompt, 'You are a helpful engineering assistant.');
    });

    it('COMPANY_ADMIN + dept: larkBase remains allowed (ADMIN ceiling includes it)', async () => {
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
      }));

      const result = await svc.resolve(baseQuery({
        companyRole: 'COMPANY_ADMIN' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      const ids = [...result.value.allowedToolIds].map(String);
      assert.ok(ids.includes('larkBase'), 'COMPANY_ADMIN ceiling allows larkBase');
    });

    it('dept cache: second call with same params does not re-query dept repos', async () => {
      let membershipCalls = 0;
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: {
          getMembership: async () => {
            membershipCalls++;
            return ok(membershipRow());
          },
        },
      }));

      const q = baseQuery({ companyRole: 'MEMBER' as any, departmentId: DEPT_ID as any });
      await svc.resolve(q);
      const first = membershipCalls;
      await svc.resolve(q);

      assert.equal(membershipCalls, first, 'dept repos should not be hit on cached call');
    });
  });

  // ── canInvoke ──────────────────────────────────────────────────────────────

  describe('canInvoke', () => {
    it('allowed tool+action returns ok(true)', async () => {
      const svc = new PermissionServiceImpl(buildDeps());
      const result = await svc.canInvoke(
        baseQuery({ companyRole: 'MEMBER' as any }),
        { toolId: 'larkTask' as any, action: 'create' as any },
      );
      assert.ok(result.ok);
      assert.equal(result.value, true);
    });

    it('denied tool returns PermissionError(not_allowed)', async () => {
      const svc = new PermissionServiceImpl(buildDeps());
      const result = await svc.canInvoke(
        baseQuery({ companyRole: 'MEMBER' as any }),
        { toolId: 'larkBase' as any, action: 'read' as any },
      );
      assert.ok(!result.ok);
      assert.equal(result.error.payload.reason, 'not_allowed');
    });

    it('denied action on allowed tool returns PermissionError(not_allowed)', async () => {
      const toolActionRepo: ToolActionPermissionRepoPort = {
        getForCompany: async () => ok([
          { companyId: COMPANY_ID, toolId: 'larkTask', role: 'MEMBER', actionGroup: 'delete', enabled: false } as ToolActionPermissionRow,
        ]),
        upsert: async () => ok({} as any),
      };
      const svc = new PermissionServiceImpl(buildDeps({ toolActionRepo }));
      const result = await svc.canInvoke(
        baseQuery({ companyRole: 'MEMBER' as any }),
        { toolId: 'larkTask' as any, action: 'delete' as any },
      );
      assert.ok(!result.ok);
      assert.equal(result.error.payload.reason, 'not_allowed');
    });
  });
});
