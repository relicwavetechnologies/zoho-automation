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
import { ok, err } from '../../src/shared/result.ts';
import { wrapInfra } from '../../src/shared/errors.ts';
import type { PermissionQuery } from '../../src/application/permissions/permission.types.ts';
import { asToolId } from '../../src/shared/ids.ts';

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
    setNx: async (k, v) => { if (store.has(k)) return ok(false); store.set(k, v); return ok(true); },
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
    it('MEMBER gets default operational tools and NOT larkBase/larkApproval', async () => {
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
      assert.ok(ids.includes('zohoCrm'),       'MEMBER should have zohoCrm by default');
      assert.ok(ids.includes('zohoBooks'),     'MEMBER should have zohoBooks by default');
      assert.ok(ids.includes('knowledge'), 'MEMBER should have governed knowledge access by default');
      assert.deepEqual(
        [...(result.value.allowedActionsByTool.get(asToolId('knowledge')) ?? [])],
        ['read', 'create', 'update', 'delete'],
      );
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

    it('allows OMS Site Data for company admins only and ignores ordinary role overrides', async () => {
      const toolPermRepo: ToolPermissionRepoPort = {
        getForCompany: async () => ok([
          { companyId: COMPANY_ID, toolId: 'omsSiteData', role: 'MEMBER', enabled: true } as ToolPermissionRow,
        ]),
        upsert: async () => ok({} as any),
      };
      const svc = new PermissionServiceImpl(buildDeps({ toolPermRepo }));
      const member = await svc.resolve(baseQuery({ companyRole: 'MEMBER' as any }));
      const admin = await svc.resolve(baseQuery({ companyRole: 'COMPANY_ADMIN' as any, userId: 'admin-1' as any }));

      assert.ok(member.ok);
      assert.equal(member.value.allowedToolIds.has(asToolId('omsSiteData')), false);
      assert.ok(admin.ok);
      assert.deepEqual([...(admin.value.allowedActionsByTool.get(asToolId('omsSiteData')) ?? [])], ['read']);
      assert.equal(admin.value.decisions.find(decision => String(decision.toolId) === 'omsSiteData')?.source, 'company_default');
    });

    // Semrush is a metered company subscription. Its permissive company default
    // is the ceiling that lets an admin grant it to a department at all — read
    // as a grant, it handed the whole company a paid tool nobody chose to give.
    it('does not hand Semrush to a member with no department', async () => {
      const result = await new PermissionServiceImpl(buildDeps()).resolve(baseQuery({ companyRole: 'MEMBER' as any }));

      assert.ok(result.ok);
      assert.equal(result.value.allowedToolIds.has(asToolId('semrush')), false);
    });

    it('keeps the company Semrush switch authoritative as a ceiling', async () => {
      const toolPermRepo: ToolPermissionRepoPort = {
        getForCompany: async () => ok([
          { companyId: COMPANY_ID, toolId: 'semrush', role: 'MEMBER', enabled: false } as ToolPermissionRow,
        ]),
        upsert: async () => ok({} as any),
      };
      const result = await new PermissionServiceImpl(buildDeps({ toolPermRepo })).resolve(baseQuery({ companyRole: 'MEMBER' as any }));

      assert.ok(result.ok);
      assert.equal(result.value.allowedToolIds.has(asToolId('semrush')), false);
    });

    // AITable ships to company administrators first. Its MEMBER default is
    // permissive because that entry is the ceiling a department grant is
    // clamped against — read as a grant instead, it would hand every member a
    // company data connection nobody chose to share.
    it('does not hand AITable to a member with no department', async () => {
      const result = await new PermissionServiceImpl(buildDeps()).resolve(baseQuery({ companyRole: 'MEMBER' as any }));

      assert.ok(result.ok);
      assert.equal(result.value.allowedToolIds.has(asToolId('aitableDatasheets')), false);
      assert.equal(result.value.allowedToolIds.has(asToolId('aitableFields')), false);
    });

    it('gives a company admin AITable outright, without any department grant', async () => {
      const admin = await new PermissionServiceImpl(buildDeps())
        .resolve(baseQuery({ companyRole: 'COMPANY_ADMIN' as any, userId: 'admin-1' as any }));

      assert.ok(admin.ok);
      assert.deepEqual(
        [...(admin.value.allowedActionsByTool.get(asToolId('aitableDatasheets')) ?? [])],
        ['read', 'create', 'update'],
      );
      assert.equal(
        admin.value.decisions.find(decision => String(decision.toolId) === 'aitableDatasheets')?.source,
        'company_default',
      );
    });

    // Deleting records or a field is not something to acquire by holding a
    // role. The admin floor deliberately stops short of it, so it stays an
    // explicit department grant.
    it('withholds delete from the AITable company-admin floor', async () => {
      const admin = await new PermissionServiceImpl(buildDeps())
        .resolve(baseQuery({ companyRole: 'COMPANY_ADMIN' as any, userId: 'admin-1' as any }));

      assert.ok(admin.ok);
      assert.equal(admin.value.allowedActionsByTool.get(asToolId('aitableDatasheets'))?.has('delete'), false);
      assert.equal(admin.value.allowedActionsByTool.get(asToolId('aitableFields'))?.has('delete'), false);
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

    it('fails on company permission repository errors without caching default authorization', async () => {
      let attempts = 0;
      const toolPermRepo: ToolPermissionRepoPort = {
        getForCompany: async () => {
          attempts++;
          return attempts === 1
            ? err(wrapInfra('prisma', 'getToolPermissions', new Error('db unavailable')))
            : ok([]);
        },
        upsert: async () => ok({} as any),
      };
      const svc = new PermissionServiceImpl(buildDeps({ toolPermRepo }));
      const query = baseQuery({ companyRole: 'MEMBER' as any });
      const first = await svc.resolve(query);
      assert.ok(!first.ok);
      assert.equal(first.error.payload.reason, 'not_allowed');
      const second = await svc.resolve(query);
      assert.ok(second.ok);
      assert.equal(attempts, 2);
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

    it('missing dept-role row denies ordinary tools but inherits central knowledge RBAC', async () => {
      // Department context is a grant matrix: no explicit row means not allowed,
      // even when the company MEMBER default would allow the tool.
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: {
          getMembership: async () => ok(membershipRow({
            roleSlug: 'MANAGER',
            roleId: 'role_mgr_001',
          })),
        },
        deptToolPermRepo: emptyDeptToolPermRepo(),
        deptUserOverrideRepo: emptyUserOverrideRepo(),
      }));

      const result = await svc.resolve(baseQuery({
        companyRole: 'MEMBER' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok, 'should resolve successfully');
      const taskActions = [...(result.value.allowedActionsByTool.get('larkTask' as any) ?? [])];
      assert.equal(taskActions.length, 0, 'larkTask must be denied when no dept-role grant exists');
      assert.deepEqual(
        [...result.value.allowedToolIds].map(String),
        ['knowledge'],
        'only the explicitly company-inherited knowledge authority remains available',
      );
    });

    it('fails instead of converting a department permission repository error into an empty grant', async () => {
      const failingDeptPermRepo: DeptToolPermissionRepoPort = {
        getForDeptRole: async () => err(wrapInfra('prisma', 'getDeptToolPermissions', new Error('db unavailable'))),
        upsert: async () => ok({} as any),
      };
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo: failingDeptPermRepo,
      }));
      const result = await svc.resolve(baseQuery({ companyRole: 'MEMBER' as any, departmentId: DEPT_ID as any }));
      assert.ok(!result.ok);
      // Not `department_access_denied`. Callers act on the difference: a
      // denial is durable and gets recorded and explained to a person, while
      // an unreadable store should be retried. Reporting this one as a denial
      // turned a database blip into a permanent-looking refusal.
      assert.equal(result.error.payload.reason, 'permission_lookup_failed');
    });

    it('dept-role explicit allow → allowed when under company ceiling', async () => {
      const deptToolPermRepo: DeptToolPermissionRepoPort = {
        getForDeptRole: async () => ok([
          { departmentId: DEPT_ID, roleId: 'role_001', toolId: 'larkTask', actionGroup: 'create', allowed: true },
          { departmentId: DEPT_ID, roleId: 'role_001', toolId: 'larkTask', actionGroup: 'read', allowed: true },
        ]),
        upsert: async () => ok({} as any),
      };
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo,
        deptUserOverrideRepo: emptyUserOverrideRepo(),
      }));

      const result = await svc.resolve(baseQuery({
        companyRole: 'MEMBER' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      const taskActions = [...(result.value.allowedActionsByTool.get('larkTask' as any) ?? [])];
      assert.ok(taskActions.includes('create'), 'explicit dept allow must grant larkTask:create');
      assert.ok(taskActions.includes('read'), 'explicit dept allow must grant larkTask:read');

      const createDecision = result.value.decisions.find(
        d => String(d.toolId) === 'larkTask' && d.actionGroup === 'create',
      );
      assert.ok(createDecision);
      assert.equal(createDecision.source, 'department_role');
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

    it('COMPANY_ADMIN + dept: explicit larkBase grant allowed under ADMIN ceiling', async () => {
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
        companyRole: 'COMPANY_ADMIN' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      const ids = [...result.value.allowedToolIds].map(String);
      assert.ok(ids.includes('larkBase'), 'COMPANY_ADMIN ceiling allows explicit larkBase grant');
    });

    it('keeps OMS Site Data available to a company admin in a department context without a department grant', async () => {
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo: emptyDeptToolPermRepo(),
        deptUserOverrideRepo: emptyUserOverrideRepo(),
      }));
      const result = await svc.resolve(baseQuery({
        companyRole: 'COMPANY_ADMIN' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      assert.deepEqual([...(result.value.allowedActionsByTool.get(asToolId('omsSiteData')) ?? [])], ['read']);
    });

    // OMS used to be classified a fixed 'system' tool, so every write path
    // rejected it and no department could ever be granted it. It is now
    // grantable — but only explicitly, never inherited from a role default.
    it('honours an explicit department grant of OMS Site Data for an ordinary member', async () => {
      const deptToolPermRepo: DeptToolPermissionRepoPort = {
        getForDeptRole: async () => ok([
          { departmentId: DEPT_ID, roleId: 'role_001', toolId: 'omsSiteData', actionGroup: 'read', allowed: true },
        ]),
        upsert: async () => ok({} as any),
      };
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo,
        deptUserOverrideRepo: emptyUserOverrideRepo(),
      }));
      const result = await svc.resolve(baseQuery({
        companyRole: 'MEMBER' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      assert.deepEqual([...(result.value.allowedActionsByTool.get(asToolId('omsSiteData')) ?? [])], ['read']);
    });

    it('still denies OMS Site Data to a department member with no explicit grant', async () => {
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo: emptyDeptToolPermRepo(),
        deptUserOverrideRepo: emptyUserOverrideRepo(),
      }));
      const result = await svc.resolve(baseQuery({
        companyRole: 'MEMBER' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      assert.equal(result.value.allowedToolIds.has(asToolId('omsSiteData')), false);
    });

    it('honours an explicit department grant of Semrush for an ordinary member', async () => {
      const deptToolPermRepo: DeptToolPermissionRepoPort = {
        getForDeptRole: async () => ok([
          { departmentId: DEPT_ID, roleId: 'role_001', toolId: 'semrush', actionGroup: 'read', allowed: true },
        ]),
        upsert: async () => ok({} as any),
      };
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo,
        deptUserOverrideRepo: emptyUserOverrideRepo(),
      }));
      const result = await svc.resolve(baseQuery({ companyRole: 'MEMBER' as any, departmentId: DEPT_ID as any }));

      assert.ok(result.ok);
      assert.deepEqual([...(result.value.allowedActionsByTool.get(asToolId('semrush')) ?? [])], ['read']);
    });

    it('still denies Semrush to a department member with no explicit grant', async () => {
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo: emptyDeptToolPermRepo(),
        deptUserOverrideRepo: emptyUserOverrideRepo(),
      }));
      const result = await svc.resolve(baseQuery({ companyRole: 'MEMBER' as any, departmentId: DEPT_ID as any }));

      assert.ok(result.ok);
      assert.equal(result.value.allowedToolIds.has(asToolId('semrush')), false);
    });

    it('honours an explicit department grant of AITable for an ordinary member', async () => {
      const deptToolPermRepo: DeptToolPermissionRepoPort = {
        getForDeptRole: async () => ok([
          { departmentId: DEPT_ID, roleId: 'role_001', toolId: 'aitableDatasheets', actionGroup: 'read', allowed: true },
        ]),
        upsert: async () => ok({} as any),
      };
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo,
        deptUserOverrideRepo: emptyUserOverrideRepo(),
      }));
      const result = await svc.resolve(baseQuery({ companyRole: 'MEMBER' as any, departmentId: DEPT_ID as any }));

      assert.ok(result.ok);
      assert.deepEqual([...(result.value.allowedActionsByTool.get(asToolId('aitableDatasheets')) ?? [])], ['read']);
    });

    it('still denies AITable to a department member with no explicit grant', async () => {
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo: emptyDeptToolPermRepo(),
        deptUserOverrideRepo: emptyUserOverrideRepo(),
      }));
      const result = await svc.resolve(baseQuery({ companyRole: 'MEMBER' as any, departmentId: DEPT_ID as any }));

      assert.ok(result.ok);
      assert.equal(result.value.allowedToolIds.has(asToolId('aitableDatasheets')), false);
      assert.equal(result.value.allowedToolIds.has(asToolId('aitableFields')), false);
    });

    it('keeps AITable available to a company admin in a department context without a department grant', async () => {
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo: emptyDeptToolPermRepo(),
        deptUserOverrideRepo: emptyUserOverrideRepo(),
      }));
      const result = await svc.resolve(baseQuery({
        companyRole: 'COMPANY_ADMIN' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      assert.deepEqual(
        [...(result.value.allowedActionsByTool.get(asToolId('aitableDatasheets')) ?? [])],
        ['read', 'create', 'update'],
      );
    });

    it('keeps Airtable available to a company admin in a department context without a department grant', async () => {
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo: emptyDeptToolPermRepo(),
        deptUserOverrideRepo: emptyUserOverrideRepo(),
      }));
      const result = await svc.resolve(baseQuery({
        companyRole: 'COMPANY_ADMIN' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      for (const toolId of ['airtableRecords', 'airtableSchema', 'airtableAutomation']) {
        assert.deepEqual(
          [...(result.value.allowedActionsByTool.get(asToolId(toolId)) ?? [])].sort(),
          ['create', 'read', 'update'],
          `${toolId} should be granted to a company admin outright`,
        );
      }
    });

    it('denies Airtable to a department member with no grant, unlike the company admin', async () => {
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo: emptyDeptToolPermRepo(),
        deptUserOverrideRepo: emptyUserOverrideRepo(),
      }));
      const result = await svc.resolve(baseQuery({
        companyRole: 'MEMBER' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      assert.equal(result.value.allowedToolIds.has(asToolId('airtableRecords')), false);
    });

    it('derives dataExport:create from a supported department source read grant', async () => {
      const deptToolPermRepo: DeptToolPermissionRepoPort = {
        getForDeptRole: async () => ok([
          { departmentId: DEPT_ID, roleId: 'role_member_001', toolId: 'airtableRecords', actionGroup: 'read', allowed: true },
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
      assert.equal(result.value.allowedActionsByTool.get(asToolId('dataExport'))?.has('create'), true);
      assert.equal(
        result.value.decisions.find(decision => String(decision.toolId) === 'dataExport')?.source,
        'derived',
      );
    });

    it('honors an explicit department denial of derived dataExport access', async () => {
      const deptToolPermRepo: DeptToolPermissionRepoPort = {
        getForDeptRole: async () => ok([
          { departmentId: DEPT_ID, roleId: 'role_member_001', toolId: 'zohoBooks', actionGroup: 'read', allowed: true },
          { departmentId: DEPT_ID, roleId: 'role_member_001', toolId: 'dataExport', actionGroup: 'create', allowed: false },
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
      assert.equal(
        result.value.allowedActionsByTool.get(asToolId('dataExport'))?.has('create') ?? false,
        false,
      );
    });

    // The admin grant is a floor. OMS is exclusive and replaces whatever the
    // department says; Airtable must not, or opening it to a role later would
    // be silently overwritten by the admin's narrower action set.
    it('keeps a department grant that reaches further than the Airtable admin floor', async () => {
      const deptToolPermRepo: DeptToolPermissionRepoPort = {
        getForDeptRole: async () => ok([
          { departmentId: DEPT_ID, roleId: 'role_001', toolId: 'airtableRecords', actionGroup: 'delete', allowed: true },
        ]),
        upsert: async () => ok({} as any),
      };
      const svc = new PermissionServiceImpl(buildDeps({
        deptRepo: { getMembership: async () => ok(membershipRow()) },
        deptToolPermRepo,
        deptUserOverrideRepo: emptyUserOverrideRepo(),
      }));
      const result = await svc.resolve(baseQuery({
        companyRole: 'COMPANY_ADMIN' as any,
        departmentId: DEPT_ID as any,
      }));

      assert.ok(result.ok);
      assert.deepEqual(
        [...(result.value.allowedActionsByTool.get(asToolId('airtableRecords')) ?? [])].sort(),
        ['create', 'delete', 'read', 'update'],
      );
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
