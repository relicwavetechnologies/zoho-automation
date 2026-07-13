/**
 * ZohoBooksSearchAdapter — implements ZohoBooksPort for the ContextSearchBroker.
 *
 * The broker's port (ZohoBooksPort) has a richer interface than ZohoBooksClientPort:
 *   - listOrganizations()  — multi-org support
 *   - listContacts()       — paginated search with query param
 *   - listInvoices()       — paginated search with query param
 *   - getRecord()          — single record fetch
 *
 * This adapter bridges ZohoBooksPaginatedClient (which has all of that) into the
 * ZohoBooksPort shape that the context search broker expects.
 *
 * Wire in composition.ts instead of the null proxy.
 */

import type { ZohoBooksPort } from '../../application/context-search/context-search.ports';
import type {
  ZohoBooksOrganization,
  ZohoBooksListResult as PaginatedResult,
} from './zoho-books-paginated.client';
import type { ZohoBooksPaginatedClient } from './zoho-books-paginated.client';
import type {
  ZohoBooksListResult,
  ZohoBooksOrg,
} from '../../application/context-search/context-search.ports';
import { filterZohoRecordsByEmail, isPersonalizedZohoScope, normalizedEmail, recordMatchesZohoEmail } from '../../shared/zoho-personalization';

export class ZohoBooksSearchAdapter implements ZohoBooksPort {
  constructor(private readonly client: ZohoBooksPaginatedClient) {}

  async listOrganizations(companyId: string): Promise<ZohoBooksOrg[]> {
    const orgs: ZohoBooksOrganization[] = await this.client.listOrganizations(companyId);
    return orgs.map(o => ({
      organizationId: o.organizationId,
      ...(o.name ? { name: o.name } : {}),
    }));
  }

  async listContacts(input: {
    companyId:                string;
    userId:                   string;
    requesterEmail?:          string;
    requesterAiRole?:         string;
    departmentId?:            string;
    departmentZohoReadScope?: string;
    organizationId?:          string;
    query?:                   string;
    page:                     number;
    perPage:                  number;
  }): Promise<ZohoBooksListResult> {
    const requesterEmail = normalizedEmail(input.requesterEmail);
    if (isPersonalizedZohoScope(input.departmentZohoReadScope) && !requesterEmail) return { allowed: false, records: [] };
    let result: PaginatedResult;
    try {
      result = await this.client.listRecords({
        companyId:  input.companyId,
        moduleName: 'contacts',
        ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
        ...(input.query          !== undefined ? { query:          input.query }          : {}),
        page:    input.page,
        perPage: input.perPage,
      });
    } catch {
      return { allowed: false, records: [] };
    }

    return {
      allowed:        true,
      organizationId: result.organizationId,
      records:        requesterEmail && isPersonalizedZohoScope(input.departmentZohoReadScope)
        ? filterZohoRecordsByEmail(result.items, requesterEmail)
        : result.items,
    };
  }

  async listInvoices(input: {
    companyId:                string;
    userId:                   string;
    requesterEmail?:          string;
    requesterAiRole?:         string;
    departmentId?:            string;
    departmentZohoReadScope?: string;
    organizationId?:          string;
    query?:                   string;
    page:                     number;
    perPage:                  number;
  }): Promise<ZohoBooksListResult> {
    const requesterEmail = normalizedEmail(input.requesterEmail);
    if (isPersonalizedZohoScope(input.departmentZohoReadScope) && !requesterEmail) return { allowed: false, records: [] };
    let result: PaginatedResult;
    try {
      result = await this.client.listRecords({
        companyId:  input.companyId,
        moduleName: 'invoices',
        ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
        ...(input.query          !== undefined ? { query:          input.query }          : {}),
        page:    input.page,
        perPage: input.perPage,
      });
    } catch {
      return { allowed: false, records: [] };
    }

    return {
      allowed:        true,
      organizationId: result.organizationId,
      records:        requesterEmail && isPersonalizedZohoScope(input.departmentZohoReadScope)
        ? filterZohoRecordsByEmail(result.items, requesterEmail)
        : result.items,
    };
  }

  async getRecord(input: {
    companyId:                string;
    userId:                   string;
    requesterEmail?:          string;
    requesterAiRole?:         string;
    departmentId?:            string;
    departmentZohoReadScope?: string;
    organizationId?:          string;
    module:                   'contacts' | 'invoices';
    recordId:                 string;
  }): Promise<{ allowed: boolean; organizationId?: string; record?: Record<string, unknown> }> {
    const requesterEmail = normalizedEmail(input.requesterEmail);
    if (isPersonalizedZohoScope(input.departmentZohoReadScope) && !requesterEmail) return { allowed: false };
    const record = await this.client.getRecord({
      companyId:  input.companyId,
      moduleName: input.module,
      recordId:   input.recordId,
      ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
    });

    if (!record) return { allowed: true };
    if (requesterEmail && isPersonalizedZohoScope(input.departmentZohoReadScope) && !recordMatchesZohoEmail(record, requesterEmail)) return { allowed: true };

    const orgId = await this.client.resolveOrganizationId(input.companyId, input.organizationId);
    return { allowed: true, organizationId: orgId, record };
  }
}
