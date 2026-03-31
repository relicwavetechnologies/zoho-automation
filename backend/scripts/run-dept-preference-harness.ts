import assert from 'node:assert/strict';

import { departmentPreferenceService } from '../src/company/departments/department-preference.service';
import { cacheRedisConnection } from '../src/company/queue/runtime/redis.connection';
import { prisma } from '../src/utils/prisma';

type PreferenceRow = {
  companyId: string;
  userId: string;
  activeDepartmentId: string | null;
};

type Membership = {
  id: string;
  name: string;
  slug: string;
  roleId: string;
  roleSlug: string;
  roleName: string;
  canManage: boolean;
};

const redisStore = new Map<string, string>();
let dbReads = 0;

const rows = new Map<string, PreferenceRow>();
const keyFor = (companyId: string, userId: string) => `${companyId}:${userId}`;

const originalGetClient = cacheRedisConnection.getClient.bind(cacheRedisConnection);
const originalPreferenceModel = (prisma as any).userDepartmentPreference;

(cacheRedisConnection as any).getClient = () => ({
  get: async (key: string) => redisStore.get(key) ?? null,
  set: async (key: string, value: string) => {
    redisStore.set(key, value);
    return 'OK';
  },
  del: async (key: string) => {
    redisStore.delete(key);
    return 1;
  },
});

(prisma as any).userDepartmentPreference = {
  findUnique: async ({ where }: any) => {
    dbReads += 1;
    return rows.get(keyFor(where.companyId_userId.companyId, where.companyId_userId.userId)) ?? null;
  },
  upsert: async ({ where, update, create }: any) => {
    const key = keyFor(where.companyId_userId.companyId, where.companyId_userId.userId);
    const existing = rows.get(key);
    const next: PreferenceRow = existing
      ? {
          ...existing,
          activeDepartmentId: update.activeDepartmentId ?? null,
        }
      : {
          companyId: create.companyId,
          userId: create.userId,
          activeDepartmentId: create.activeDepartmentId ?? null,
        };
    rows.set(key, next);
    return next;
  },
};

async function run(): Promise<void> {
  rows.set(keyFor('company_a', 'user_a'), {
    companyId: 'company_a',
    userId: 'user_a',
    activeDepartmentId: 'dept_cached',
  });
  redisStore.set('user-dept:company_a:user_a', 'dept_cached');
  dbReads = 0;
  const cached = await departmentPreferenceService.getActiveDepartmentId('company_a', 'user_a');
  assert.equal(cached, 'dept_cached');
  assert.equal(dbReads, 0);

  redisStore.delete('user-dept:company_a:user_a');
  dbReads = 0;
  const rewarmed = await departmentPreferenceService.getActiveDepartmentId('company_a', 'user_a');
  assert.equal(rewarmed, 'dept_cached');
  assert.equal(dbReads, 1);
  assert.equal(redisStore.get('user-dept:company_a:user_a'), 'dept_cached');

  const memberships: Membership[] = [
    {
      id: 'dept_cached',
      name: 'Finance',
      slug: 'finance',
      roleId: 'role_1',
      roleSlug: 'MEMBER',
      roleName: 'Member',
      canManage: false,
    },
  ];
  const persisted = await departmentPreferenceService.resolveForRuntime(
    'company_a',
    'user_a',
    memberships,
  );
  assert.deepEqual(persisted, { departmentId: 'dept_cached', reason: 'persisted' });

  rows.set(keyFor('company_b', 'user_b'), {
    companyId: 'company_b',
    userId: 'user_b',
    activeDepartmentId: 'dept_old',
  });
  redisStore.set('user-dept:company_b:user_b', 'dept_old');
  const invalidPersisted = await departmentPreferenceService.resolveForRuntime(
    'company_b',
    'user_b',
    [
      {
        id: 'dept_new',
        name: 'Ops',
        slug: 'ops',
        roleId: 'role_2',
        roleSlug: 'MEMBER',
        roleName: 'Member',
        canManage: false,
      },
    ],
  );
  assert.deepEqual(invalidPersisted, { departmentId: 'dept_new', reason: 'auto_selected' });
  assert.equal(rows.get(keyFor('company_b', 'user_b'))?.activeDepartmentId, 'dept_new');

  const autoSelected = await departmentPreferenceService.resolveForRuntime(
    'company_c',
    'user_c',
    [
      {
        id: 'dept_only',
        name: 'Sales',
        slug: 'sales',
        roleId: 'role_3',
        roleSlug: 'MEMBER',
        roleName: 'Member',
        canManage: false,
      },
    ],
  );
  assert.deepEqual(autoSelected, { departmentId: 'dept_only', reason: 'auto_selected' });
  assert.equal(rows.get(keyFor('company_c', 'user_c'))?.activeDepartmentId, 'dept_only');

  const needsSelection = await departmentPreferenceService.resolveForRuntime(
    'company_d',
    'user_d',
    [
      {
        id: 'dept_1',
        name: 'Legal',
        slug: 'legal',
        roleId: 'role_4',
        roleSlug: 'MEMBER',
        roleName: 'Member',
        canManage: false,
      },
      {
        id: 'dept_2',
        name: 'Finance',
        slug: 'finance',
        roleId: 'role_5',
        roleSlug: 'MANAGER',
        roleName: 'Manager',
        canManage: true,
      },
    ],
  );
  assert.deepEqual(needsSelection, { departmentId: null, reason: 'needs_selection' });

  console.log('dept-preference-harness-ok');
}

run()
  .finally(() => {
    (cacheRedisConnection as any).getClient = originalGetClient;
    (prisma as any).userDepartmentPreference = originalPreferenceModel;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
