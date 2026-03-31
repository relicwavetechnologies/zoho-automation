import assert from 'node:assert/strict';

import {
  compileBooksNativeFilters,
  verifyBooksRecordOwnership,
} from '../src/company/integrations/zoho/zoho-books-scope.compiler';
import { BooksModulePermissionService } from '../src/company/integrations/zoho/books-module-permission.service';
import { booksModulePermissionService } from '../src/company/integrations/zoho/books-module-permission.service';
import { booksModulePermissionRepository } from '../src/company/integrations/zoho/books-module-permission.repository';
import { zohoGatewayService } from '../src/company/integrations/zoho/zoho-gateway.service';
import { zohoPrincipalResolver } from '../src/company/integrations/zoho/zoho-principal.resolver';
import { zohoBooksClient } from '../src/company/integrations/zoho/zoho-books.client';
import { cacheRedisConnection } from '../src/company/queue/runtime/redis.connection';

type PermissionRow = {
  companyId: string;
  departmentRoleId: string;
  module: string;
  enabled: boolean;
  scopeOverride: string | null;
};

const rows: PermissionRow[] = [];
const cache = new Map<string, string>();

const originalGetClient = cacheRedisConnection.getClient.bind(cacheRedisConnection);
const originalGetForRole = booksModulePermissionRepository.getForRole.bind(booksModulePermissionRepository);
const originalResolveModuleAccess = booksModulePermissionService.resolveModuleAccess.bind(booksModulePermissionService);
const originalResolveScopeContext = zohoPrincipalResolver.resolveScopeContext.bind(zohoPrincipalResolver);
const originalListRecords = zohoBooksClient.listRecords.bind(zohoBooksClient);

(cacheRedisConnection as any).getClient = () => ({
  get: async (key: string) => cache.get(key) ?? null,
  set: async (key: string, value: string) => {
    cache.set(key, value);
    return 'OK';
  },
  del: async (key: string) => {
    cache.delete(key);
    return 1;
  },
});

(booksModulePermissionRepository as any).getForRole = async (companyId: string, departmentRoleId: string) =>
  rows.filter((row) => row.companyId === companyId && row.departmentRoleId === departmentRoleId);

async function run(): Promise<void> {
  const service = new BooksModulePermissionService(booksModulePermissionRepository as any);

  rows.length = 0;
  cache.clear();
  const inherited = await service.resolveModuleAccess('company_a', 'role_a', 'contacts', 'personalized');
  assert.deepEqual(inherited, { enabled: true, scopeMode: 'personalized' });

  rows.push({
    companyId: 'company_a',
    departmentRoleId: 'role_a',
    module: 'contacts',
    enabled: false,
    scopeOverride: null,
  });
  cache.clear();
  const disabled = await service.resolveModuleAccess('company_a', 'role_a', 'contacts', 'show_all');
  assert.deepEqual(disabled, { enabled: false, scopeMode: 'show_all' });

  rows[0] = {
    companyId: 'company_a',
    departmentRoleId: 'role_a',
    module: 'contacts',
    enabled: true,
    scopeOverride: 'show_all',
  };
  cache.clear();
  const overrideScope = await service.resolveModuleAccess('company_a', 'role_a', 'contacts', 'personalized');
  assert.deepEqual(overrideScope, { enabled: true, scopeMode: 'show_all' });

  rows[0] = {
    companyId: 'company_a',
    departmentRoleId: 'role_a',
    module: 'contacts',
    enabled: true,
    scopeOverride: null,
  };
  cache.clear();
  const nullOverride = await service.resolveModuleAccess('company_a', 'role_a', 'contacts', 'show_all');
  assert.deepEqual(nullOverride, { enabled: true, scopeMode: 'show_all' });

  assert.deepEqual(
    compileBooksNativeFilters({
      moduleName: 'contacts',
      enabled: true,
      scopeMode: 'self_scoped',
      requesterEmail: 'USER@example.com',
      allowedContactIds: [],
      filters: {},
    }),
    { email: 'user@example.com' },
  );

  assert.deepEqual(
    compileBooksNativeFilters({
      moduleName: 'invoices',
      enabled: true,
      scopeMode: 'self_scoped',
      requesterEmail: 'user@example.com',
      allowedContactIds: ['contact_1'],
      filters: {},
    }),
    { customer_id: 'contact_1' },
  );

  assert.deepEqual(
    compileBooksNativeFilters({
      moduleName: 'invoices',
      enabled: true,
      scopeMode: 'self_scoped',
      requesterEmail: 'user@example.com',
      allowedContactIds: [],
      filters: {},
    }),
    {},
  );

  assert.deepEqual(
    verifyBooksRecordOwnership({
      moduleName: 'invoices',
      payload: { customer_id: 'contact_1' },
      requesterEmail: 'user@example.com',
      allowedContactIds: ['contact_1'],
    }),
    { allowed: true, reason: undefined, matchedBy: ['contact_id'] },
  );

  const notMatched = verifyBooksRecordOwnership({
    moduleName: 'invoices',
    payload: { customer_id: 'contact_2' },
    requesterEmail: 'user@example.com',
    allowedContactIds: ['contact_1'],
  });
  assert.equal(notMatched.allowed, false);
  assert.equal(notMatched.reason, 'ownership_not_matched');

  (zohoPrincipalResolver as any).resolveScopeContext = async () => ({
    companyId: 'company_a',
    domain: 'books',
    scopeMode: 'self_scoped',
    departmentRoleId: 'role_a',
    departmentZohoReadScope: 'personalized',
    normalizedRequesterEmail: 'user@example.com',
    books: { contactIds: ['contact_1'] },
  });
  (booksModulePermissionService as any).resolveModuleAccess = async () => ({
    enabled: false,
    scopeMode: 'personalized',
  });
  (zohoBooksClient as any).listRecords = async () => {
    throw new Error('should_not_call_books_client');
  };

  const denied = await zohoGatewayService.listAuthorizedRecords({
    domain: 'books',
    module: 'invoices',
    requester: {
      companyId: 'company_a',
      departmentRoleId: 'role_a',
      departmentZohoReadScope: 'personalized',
      requesterEmail: 'user@example.com',
    },
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.denialReason, 'books_module_access_denied');

  console.log('books-scope-harness-ok');
}

run()
  .finally(() => {
    (cacheRedisConnection as any).getClient = originalGetClient;
    (booksModulePermissionRepository as any).getForRole = originalGetForRole;
    (booksModulePermissionService as any).resolveModuleAccess = originalResolveModuleAccess;
    (zohoPrincipalResolver as any).resolveScopeContext = originalResolveScopeContext;
    (zohoBooksClient as any).listRecords = originalListRecords;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
