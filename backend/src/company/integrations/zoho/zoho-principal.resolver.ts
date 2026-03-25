import { logger } from '../../../utils/logger';
import { normalizeEmail, extractNormalizedEmails } from './zoho-email-scope';
import { zohoBooksClient } from './zoho-books.client';
import type { ZohoDomain, ZohoGatewayPrincipalContext, ZohoGatewayScopeMode } from './zoho-gateway.types';

const BOOKS_PRINCIPAL_CACHE_TTL_MS = 5 * 60_000;

type CachedEntry = {
  expiresAt: number;
  value: ZohoGatewayPrincipalContext;
};

const booksPrincipalCache = new Map<string, CachedEntry>();

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const readContactId = (record: Record<string, unknown>): string | undefined =>
  asString(record.contact_id) ?? asString(record.id);

const cacheKeyFor = (input: {
  companyId: string;
  requesterEmail?: string;
  requesterAiRole?: string;
  departmentZohoReadScope?: 'personalized' | 'show_all';
  domain: ZohoDomain;
}) =>
  [
    input.companyId,
    input.domain,
    input.requesterAiRole ?? '',
    input.departmentZohoReadScope ?? 'personalized',
    normalizeEmail(input.requesterEmail) ?? '',
  ].join(':');

const resolveGatewayScopeMode = (scope?: 'personalized' | 'show_all'): ZohoGatewayScopeMode =>
  scope === 'show_all' ? 'company_scoped' : 'self_scoped';

export class ZohoPrincipalResolver {
  async resolveScopeContext(input: {
    companyId: string;
    requesterEmail?: string;
    requesterAiRole?: string;
    departmentZohoReadScope?: 'personalized' | 'show_all';
    domain: ZohoDomain;
  }): Promise<ZohoGatewayPrincipalContext> {
    const scopeMode = resolveGatewayScopeMode(input.departmentZohoReadScope);
    const normalizedRequesterEmail = normalizeEmail(input.requesterEmail);
    const base: ZohoGatewayPrincipalContext = {
      companyId: input.companyId,
      requesterEmail: input.requesterEmail,
      requesterAiRole: input.requesterAiRole,
      departmentZohoReadScope: input.departmentZohoReadScope,
      normalizedRequesterEmail,
      domain: input.domain,
      scopeMode,
    };

    if (scopeMode === 'company_scoped') {
      return base;
    }
    if (!normalizedRequesterEmail) {
      return base;
    }
    if (input.domain === 'crm') {
      return {
        ...base,
        crm: {
          sourceTypes: ['zoho_lead', 'zoho_contact', 'zoho_account', 'zoho_deal', 'zoho_ticket'],
        },
      };
    }

    const cacheKey = cacheKeyFor(input);
    const cached = booksPrincipalCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const result = await zohoBooksClient.listRecords({
      companyId: input.companyId,
      moduleName: 'contacts',
      filters: {
        email: normalizedRequesterEmail,
      },
      limit: 20,
    });
    const contactIds = result.items
      .filter((record) => extractNormalizedEmails(record).includes(normalizedRequesterEmail))
      .map((record) => readContactId(record))
      .filter((value): value is string => Boolean(value));

    const resolved: ZohoGatewayPrincipalContext = {
      ...base,
      books: {
        contactIds: [...new Set(contactIds)],
      },
    };

    booksPrincipalCache.set(cacheKey, {
      expiresAt: Date.now() + BOOKS_PRINCIPAL_CACHE_TTL_MS,
      value: resolved,
    });
    logger.info('zoho.gateway.principal.books_resolved', {
      companyId: input.companyId,
      requesterEmail: normalizedRequesterEmail,
      contactCount: resolved.books?.contactIds.length ?? 0,
    });
    return resolved;
  }
}

export const zohoPrincipalResolver = new ZohoPrincipalResolver();
