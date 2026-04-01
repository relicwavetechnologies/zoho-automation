import { logger } from '../../../utils/logger';
import { zohoBooksClient, type ZohoBooksModule } from './zoho-books.client';
import { zohoDataClient } from './zoho-data.client';
import {
  compileBooksNativeFilters,
  getBooksRecordId,
  normalizeBooksGatewayModule,
  verifyBooksRecordOwnership,
} from './zoho-books-scope.compiler';
import {
  compileCrmGatewayFilters,
  crmModuleToSourceType,
  normalizeCrmGatewayModule,
  verifyCrmRecordOwnership,
} from './zoho-crm-scope.compiler';
import type {
  ZohoAuthorizationResult,
  ZohoDomain,
  ZohoGatewayChildResourceType,
  ZohoGatewayMutationInput,
  ZohoGatewayPrincipalContext,
  ZohoGatewayRequester,
} from './zoho-gateway.types';
import { zohoPrincipalResolver } from './zoho-principal.resolver';
import { booksModulePermissionService } from './books-module-permission.service';

const crmQueryMatch = (record: Record<string, unknown>, query?: string): boolean => {
  const normalized = query?.trim().toLowerCase();
  if (!normalized) return true;
  return JSON.stringify(record).toLowerCase().includes(normalized);
};

const buildDeniedResult = <TPayload = Record<string, unknown>>(input: {
  principal: ZohoGatewayPrincipalContext;
  module?: string;
  compiledFilters?: Record<string, unknown>;
  denialReason: string;
  organizationId?: string;
  payload?: TPayload;
}): ZohoAuthorizationResult<TPayload> => ({
  allowed: false,
  scopeMode: input.principal.scopeMode,
  principal: input.principal,
  module: input.module,
  compiledFilters: input.compiledFilters ?? {},
  denialReason: input.denialReason,
  organizationId: input.organizationId,
  payload: input.payload,
});

const logGatewayAudit = (input: {
  operation: string;
  domain: ZohoDomain;
  module?: string;
  requester: ZohoGatewayRequester;
  principal: ZohoGatewayPrincipalContext;
  compiledFilters?: Record<string, unknown>;
  candidateCount?: number;
  returnedCount?: number;
  droppedCount?: number;
  denialReason?: string;
}) => {
  logger.info('zoho.gateway.authorization', {
    operation: input.operation,
    domain: input.domain,
    module: input.module,
    requesterEmail: input.requester.requesterEmail,
    requesterRole: input.requester.requesterAiRole,
    scopeMode: input.principal.scopeMode,
    principalIds: {
      crmSourceTypes: input.principal.crm?.sourceTypes,
      booksContactIds: input.principal.books?.contactIds,
    },
    compiledFilters: input.compiledFilters ?? {},
    candidateCount: input.candidateCount,
    returnedCount: input.returnedCount,
    droppedCount: input.droppedCount,
    denialReason: input.denialReason,
  });
};

const resolveGatewayPrincipalContext = (input: {
  companyId: string;
  requesterEmail?: string;
  requesterAiRole?: string;
  departmentRoleId?: string;
  departmentZohoReadScope?: 'personalized' | 'show_all';
  domain: ZohoDomain;
}): Promise<ZohoGatewayPrincipalContext> => {
  // Department scope is authoritative for runtime Zoho access.
  if (input.departmentZohoReadScope) {
    return zohoPrincipalResolver.resolveScopeContext(input);
  }
  return zohoPrincipalResolver.resolveScopeContext(input);
};

const resolveBooksModuleAccess = async (input: {
  companyId: string;
  principal: ZohoGatewayPrincipalContext;
  moduleName: ZohoBooksModule;
}): Promise<{
  enabled: boolean;
  scopeMode: 'self_scoped' | 'company_scoped';
}> => {
  const access = await booksModulePermissionService.resolveModuleAccess(
    input.companyId,
    input.principal.departmentRoleId,
    input.moduleName,
    input.principal.departmentZohoReadScope,
  );
  return {
    enabled: access.enabled,
    scopeMode: access.scopeMode === 'show_all' ? 'company_scoped' : 'self_scoped',
  };
};

export class ZohoGatewayService {
  async resolveScopeContext(input: {
    companyId: string;
    requesterEmail?: string;
    requesterAiRole?: string;
    departmentRoleId?: string;
    departmentZohoReadScope?: 'personalized' | 'show_all';
    domain: ZohoDomain;
  }): Promise<ZohoGatewayPrincipalContext> {
    return resolveGatewayPrincipalContext(input);
  }

  async listAuthorizedRecords(input: {
    domain: ZohoDomain;
    module: string;
    requester: ZohoGatewayRequester;
    filters?: Record<string, unknown>;
    query?: string;
    limit?: number;
    page?: number;
    perPage?: number;
    organizationId?: string;
  }): Promise<ZohoAuthorizationResult<{ records: Record<string, unknown>[]; raw?: Record<string, unknown> }>> {
    const principal = await this.resolveScopeContext({
      companyId: input.requester.companyId,
      requesterEmail: input.requester.requesterEmail,
      requesterAiRole: input.requester.requesterAiRole,
      departmentRoleId: input.requester.departmentRoleId,
      departmentZohoReadScope: input.requester.departmentZohoReadScope,
      domain: input.domain,
    });

    if (input.domain === 'crm') {
      const moduleName = normalizeCrmGatewayModule(input.module);
      if (!moduleName) {
        return buildDeniedResult({
          principal,
          module: input.module,
          denialReason: 'unsupported_crm_module',
        });
      }
      const compiledFilters = compileCrmGatewayFilters(input.filters);
      const limit = Math.max(1, Math.min(50, input.limit ?? 25));

      try {
        const records = principal.scopeMode === 'company_scoped'
          ? await zohoDataClient.listModuleRecords({
            companyId: input.requester.companyId,
            moduleName,
            filters: compiledFilters,
            perPage: limit,
          })
          : principal.normalizedRequesterEmail
            ? (await zohoDataClient.fetchUserScopedRecords({
              companyId: input.requester.companyId,
              sourceType: crmModuleToSourceType(moduleName),
              requesterEmail: principal.normalizedRequesterEmail,
              limit,
              maxPages: 4,
              filters: compiledFilters,
            })).map((record) => record.payload)
            : [];

        const filtered = records.filter((record) => crmQueryMatch(record, input.query)).slice(0, limit);
        const result: ZohoAuthorizationResult<{ records: Record<string, unknown>[]; raw?: Record<string, unknown> }> = {
          allowed: principal.scopeMode === 'company_scoped' || Boolean(principal.normalizedRequesterEmail),
          scopeMode: principal.scopeMode,
          principal,
          module: moduleName,
          compiledFilters,
          payload: { records: filtered },
          candidateCount: records.length,
          returnedCount: filtered.length,
          droppedCount: Math.max(0, records.length - filtered.length),
          denialReason:
            principal.scopeMode === 'self_scoped' && !principal.normalizedRequesterEmail
              ? 'missing_requester_email'
              : undefined,
        };
        logGatewayAudit({
          operation: 'listAuthorizedRecords',
          domain: input.domain,
          module: moduleName,
          requester: input.requester,
          principal,
          compiledFilters,
          candidateCount: result.candidateCount,
          returnedCount: result.returnedCount,
          droppedCount: result.droppedCount,
          denialReason: result.denialReason,
        });
        return result.allowed ? result : buildDeniedResult({
          principal,
          module: moduleName,
          compiledFilters,
          denialReason: result.denialReason ?? 'unauthorized',
        });
      } catch (error) {
        throw error;
      }
    }

    const moduleName = normalizeBooksGatewayModule(input.module);
    if (!moduleName) {
      return buildDeniedResult({
        principal,
        module: input.module,
        denialReason: 'unsupported_books_module',
      });
    }
    const moduleAccess = await resolveBooksModuleAccess({
      companyId: input.requester.companyId,
      principal,
      moduleName,
    });
    if (!moduleAccess.enabled) {
      return buildDeniedResult({
        principal,
        module: moduleName,
        denialReason: 'books_module_access_denied',
      });
    }
    const compiledFilters = compileBooksNativeFilters({
      moduleName,
      enabled: moduleAccess.enabled,
      scopeMode: moduleAccess.scopeMode,
      requesterEmail: principal.normalizedRequesterEmail,
      allowedContactIds: principal.books?.contactIds,
      filters: input.filters,
    });
    const limit = Math.max(1, Math.min(200, input.limit ?? 25));

    if (moduleAccess.scopeMode === 'self_scoped') {
      if (!principal.normalizedRequesterEmail) {
        return buildDeniedResult({
          principal,
          module: moduleName,
          compiledFilters,
          denialReason: 'missing_requester_email',
        });
      }
      const allowedContactIds = principal.books?.contactIds ?? [];
      if (moduleName !== 'contacts' && allowedContactIds.length === 0) {
        return buildDeniedResult({
          principal,
          module: moduleName,
          compiledFilters,
          denialReason: 'books_principal_not_resolved',
        });
      }

      const buckets: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      if (moduleName === 'contacts') {
        const result = await zohoBooksClient.listRecords({
          companyId: input.requester.companyId,
          moduleName,
          organizationId: input.organizationId,
          filters: compiledFilters,
          query: input.query,
          limit,
          page: input.page,
          perPage: input.perPage,
        });
        const filtered = result.items.filter((record) =>
          verifyBooksRecordOwnership({
            moduleName,
            payload: record,
            requesterEmail: principal.normalizedRequesterEmail,
            allowedContactIds,
          }).allowed,
        );
        const droppedCount = Math.max(0, result.items.length - filtered.length);
        const payload = { records: filtered, raw: result.payload };
        logGatewayAudit({
          operation: 'listAuthorizedRecords',
          domain: input.domain,
          module: moduleName,
          requester: input.requester,
          principal,
          compiledFilters,
          candidateCount: result.items.length,
          returnedCount: filtered.length,
          droppedCount,
        });
        return {
          allowed: true,
          scopeMode: moduleAccess.scopeMode,
          principal,
          module: moduleName,
          compiledFilters,
          organizationId: result.organizationId,
          payload,
          candidateCount: result.items.length,
          returnedCount: filtered.length,
          droppedCount,
        };
      }

      const results = await Promise.all(
        allowedContactIds.map((contactId) =>
          zohoBooksClient.listRecords({
            companyId: input.requester.companyId,
            moduleName,
            organizationId: input.organizationId,
            filters: {
              ...compiledFilters,
              customer_id: contactId,
            },
            query: input.query,
            limit,
            page: input.page,
            perPage: input.perPage,
          }),
        ),
      );

      for (const result of results) {
        for (const record of result.items) {
          const verdict = verifyBooksRecordOwnership({
            moduleName,
            payload: record,
            requesterEmail: principal.normalizedRequesterEmail,
            allowedContactIds,
          });
          const recordId = getBooksRecordId(record, moduleName) ?? JSON.stringify(record);
          if (!verdict.allowed || seen.has(recordId)) {
            continue;
          }
          seen.add(recordId);
          buckets.push(record);
          if (buckets.length >= limit) {
            break;
          }
        }
        if (buckets.length >= limit) {
          break;
        }
      }

      logGatewayAudit({
        operation: 'listAuthorizedRecords',
        domain: input.domain,
        module: moduleName,
        requester: input.requester,
        principal,
        compiledFilters,
        candidateCount: buckets.length,
        returnedCount: buckets.length,
        droppedCount: 0,
      });
      return {
        allowed: true,
        scopeMode: principal.scopeMode,
        principal,
        module: moduleName,
        compiledFilters,
        organizationId: input.organizationId,
        payload: {
          records: buckets,
        },
        candidateCount: buckets.length,
        returnedCount: buckets.length,
        droppedCount: 0,
      };
    }

    const result = await zohoBooksClient.listRecords({
      companyId: input.requester.companyId,
      moduleName,
      organizationId: input.organizationId,
      filters: compiledFilters,
      query: input.query,
      limit,
      page: input.page,
      perPage: input.perPage,
    });
    logGatewayAudit({
      operation: 'listAuthorizedRecords',
      domain: input.domain,
      module: moduleName,
      requester: input.requester,
      principal,
      compiledFilters,
      candidateCount: result.items.length,
      returnedCount: result.items.length,
      droppedCount: 0,
    });
    return {
      allowed: true,
      scopeMode: moduleAccess.scopeMode,
      principal,
      module: moduleName,
      compiledFilters,
      organizationId: result.organizationId,
      payload: {
        records: result.items,
        raw: result.payload,
      },
      candidateCount: result.items.length,
      returnedCount: result.items.length,
      droppedCount: 0,
    };
  }

  async getAuthorizedRecord(input: {
    domain: ZohoDomain;
    module: string;
    recordId: string;
    requester: ZohoGatewayRequester;
    organizationId?: string;
  }): Promise<ZohoAuthorizationResult<Record<string, unknown>>> {
    const principal = await this.resolveScopeContext({
      companyId: input.requester.companyId,
      requesterEmail: input.requester.requesterEmail,
      requesterAiRole: input.requester.requesterAiRole,
      departmentRoleId: input.requester.departmentRoleId,
      departmentZohoReadScope: input.requester.departmentZohoReadScope,
      domain: input.domain,
    });

    if (input.domain === 'crm') {
      const moduleName = normalizeCrmGatewayModule(input.module);
      if (!moduleName) {
        return buildDeniedResult({
          principal,
          module: input.module,
          denialReason: 'unsupported_crm_module',
        });
      }
      if (principal.scopeMode === 'self_scoped') {
        if (!principal.normalizedRequesterEmail) {
          return buildDeniedResult({
            principal,
            module: moduleName,
            denialReason: 'missing_requester_email',
          });
        }
        const allowed = await zohoDataClient.hasUserScopedModuleRecordAccess({
          companyId: input.requester.companyId,
          moduleName,
          recordId: input.recordId,
          requesterEmail: principal.normalizedRequesterEmail,
        });
        if (!allowed) {
          logGatewayAudit({
            operation: 'getAuthorizedRecord',
            domain: input.domain,
            module: moduleName,
            requester: input.requester,
            principal,
            compiledFilters: {},
            denialReason: 'record_not_in_self_scope',
          });
          return buildDeniedResult({
            principal,
            module: moduleName,
            denialReason: 'record_not_in_self_scope',
          });
        }
      }

      const record = await zohoDataClient.getModuleRecord({
        companyId: input.requester.companyId,
        moduleName,
        recordId: input.recordId,
      });
      if (!record) {
        return buildDeniedResult({
          principal,
          module: moduleName,
          denialReason: 'record_not_found',
        });
      }
      if (principal.scopeMode === 'self_scoped') {
        const verdict = verifyCrmRecordOwnership(record, principal.normalizedRequesterEmail);
        if (!verdict.allowed) {
          return buildDeniedResult({
            principal,
            module: moduleName,
            denialReason: verdict.reason ?? 'record_not_in_self_scope',
          });
        }
      }
      logGatewayAudit({
        operation: 'getAuthorizedRecord',
        domain: input.domain,
        module: moduleName,
        requester: input.requester,
        principal,
        compiledFilters: {},
        candidateCount: 1,
        returnedCount: 1,
        droppedCount: 0,
      });
      return {
        allowed: true,
        scopeMode: principal.scopeMode,
        principal,
        module: moduleName,
        compiledFilters: {},
        payload: record,
        candidateCount: 1,
        returnedCount: 1,
        droppedCount: 0,
      };
    }

    const moduleName = normalizeBooksGatewayModule(input.module);
    if (!moduleName) {
      return buildDeniedResult({
        principal,
        module: input.module,
        denialReason: 'unsupported_books_module',
      });
    }
    const moduleAccess = await resolveBooksModuleAccess({
      companyId: input.requester.companyId,
      principal,
      moduleName,
    });
    if (!moduleAccess.enabled) {
      return buildDeniedResult({
        principal,
        module: moduleName,
        denialReason: 'books_module_access_denied',
      });
    }
    if (moduleAccess.scopeMode === 'self_scoped') {
      if (!principal.normalizedRequesterEmail) {
        return buildDeniedResult({
          principal,
          module: moduleName,
          denialReason: 'missing_requester_email',
        });
      }
    }

    const result = await zohoBooksClient.getRecord({
      companyId: input.requester.companyId,
      moduleName,
      recordId: input.recordId,
      organizationId: input.organizationId,
    });
    if (moduleAccess.scopeMode === 'self_scoped') {
      const verdict = verifyBooksRecordOwnership({
        moduleName,
        payload: result.record,
        requesterEmail: principal.normalizedRequesterEmail,
        allowedContactIds: principal.books?.contactIds,
      });
      if (!verdict.allowed) {
        logGatewayAudit({
          operation: 'getAuthorizedRecord',
          domain: input.domain,
          module: moduleName,
          requester: input.requester,
          principal,
          denialReason: verdict.reason ?? 'record_not_in_self_scope',
        });
        return buildDeniedResult({
          principal,
          module: moduleName,
          organizationId: result.organizationId,
          denialReason: verdict.reason ?? 'record_not_in_self_scope',
        });
      }
    }
    logGatewayAudit({
      operation: 'getAuthorizedRecord',
      domain: input.domain,
      module: moduleName,
      requester: input.requester,
      principal,
      candidateCount: 1,
      returnedCount: 1,
      droppedCount: 0,
    });
    return {
      allowed: true,
      scopeMode: moduleAccess.scopeMode,
      principal,
      module: moduleName,
      compiledFilters: {},
      organizationId: result.organizationId,
      payload: result.record,
      candidateCount: 1,
      returnedCount: 1,
      droppedCount: 0,
    };
  }

  async getAuthorizedChildResource(input: {
    domain: ZohoDomain;
    module: string;
    recordId: string;
    childType: ZohoGatewayChildResourceType;
    requester: ZohoGatewayRequester;
    organizationId?: string;
  }): Promise<ZohoAuthorizationResult<Record<string, unknown>>> {
    return this.getAuthorizedRecord({
      domain: input.domain,
      module: input.module,
      recordId: input.recordId,
      requester: input.requester,
      organizationId: input.organizationId,
    });
  }

  async executeAuthorizedMutation(input: ZohoGatewayMutationInput): Promise<ZohoAuthorizationResult<Record<string, unknown>>> {
    const principal = await this.resolveScopeContext({
      companyId: input.requester.companyId,
      requesterEmail: input.requester.requesterEmail,
      requesterAiRole: input.requester.requesterAiRole,
      departmentRoleId: input.requester.departmentRoleId,
      departmentZohoReadScope: input.requester.departmentZohoReadScope,
      domain: input.domain,
    });
    if (input.domain === 'crm' && principal.scopeMode === 'company_scoped') {
      const result: ZohoAuthorizationResult<Record<string, unknown>> = {
        allowed: true,
        scopeMode: principal.scopeMode,
        principal,
        module: input.module,
        compiledFilters: {},
      };
      logGatewayAudit({
        operation: 'executeAuthorizedMutation',
        domain: input.domain,
        module: input.module,
        requester: input.requester,
        principal,
      });
      return result;
    }

    if (!input.module) {
      return buildDeniedResult({
        principal,
        denialReason: 'self_scoped_mutation_requires_target_module',
      });
    }

    if (!input.recordId) {
      return buildDeniedResult({
        principal,
        module: input.module,
        denialReason: 'self_scoped_mutation_requires_target_record',
      });
    }

    if (input.domain === 'crm') {
      return this.getAuthorizedRecord({
        domain: 'crm',
        module: input.module,
        recordId: input.recordId,
        requester: input.requester,
      });
    }

    const moduleName = normalizeBooksGatewayModule(input.module);
    if (!moduleName) {
      return buildDeniedResult({
        principal,
        module: input.module,
        denialReason: 'unsupported_books_module',
      });
    }
    const moduleAccess = await resolveBooksModuleAccess({
      companyId: input.requester.companyId,
      principal,
      moduleName,
    });
    if (!moduleAccess.enabled) {
      return buildDeniedResult({
        principal,
        module: moduleName,
        denialReason: 'books_module_access_denied',
      });
    }
    if (moduleAccess.scopeMode === 'company_scoped') {
      const result: ZohoAuthorizationResult<Record<string, unknown>> = {
        allowed: true,
        scopeMode: moduleAccess.scopeMode,
        principal,
        module: moduleName,
        compiledFilters: {},
      };
      logGatewayAudit({
        operation: 'executeAuthorizedMutation',
        domain: input.domain,
        module: moduleName,
        requester: input.requester,
        principal,
      });
      return result;
    }
    return this.getAuthorizedRecord({
      domain: 'books',
      module: moduleName,
      recordId: input.recordId,
      requester: input.requester,
      organizationId: input.organizationId,
    });
  }
}

export const zohoGatewayService = new ZohoGatewayService();
