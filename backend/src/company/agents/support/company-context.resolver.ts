import config from '../../../config';
import { prisma } from '../../../utils/prisma';

export class CompanyContextResolutionError extends Error {
  readonly code: 'company_context_missing' | 'company_context_ambiguous';

  constructor(code: 'company_context_missing' | 'company_context_ambiguous', message: string) {
    super(message);
    this.name = 'CompanyContextResolutionError';
    this.code = code;
  }
}

export class CompanyContextResolver {
  async resolveCompanyId(input?: { companyId?: unknown; larkTenantKey?: unknown }): Promise<string> {
    if (typeof input?.companyId === 'string' && input.companyId.trim()) {
      const exists = await prisma.zohoConnection.findFirst({
        where: {
          companyId: input.companyId,
          status: 'CONNECTED',
        },
        select: { companyId: true },
      });

      if (exists) {
        return exists.companyId;
      }
    }

    // Try resolving companyId via Lark tenant binding when companyId is absent or unconnected
    if (typeof input?.larkTenantKey === 'string' && input.larkTenantKey.trim()) {
      const binding = await prisma.larkTenantBinding.findUnique({
        where: { larkTenantKey: input.larkTenantKey.trim() },
        select: { companyId: true, isActive: true },
      });

      if (binding?.isActive) {
        const exists = await prisma.zohoConnection.findFirst({
          where: {
            companyId: binding.companyId,
            status: 'CONNECTED',
          },
          select: { companyId: true },
        });

        if (exists) {
          return exists.companyId;
        }

        throw new CompanyContextResolutionError(
          'company_context_missing',
          'Zoho is not connected for this workspace. Please connect Zoho from the admin panel.',
        );
      }
    }

    if (config.LARK_TENANT_BINDING_ENFORCED) {
      throw new CompanyContextResolutionError(
        'company_context_missing',
        'Company context is required and must come from tenant binding',
      );
    }

    const activeConnections = await prisma.zohoConnection.findMany({
      where: {
        status: 'CONNECTED',
      },
      select: {
        companyId: true,
      },
      distinct: ['companyId'],
      take: 2,
    });

    if (activeConnections.length === 0) {
      throw new CompanyContextResolutionError(
        'company_context_missing',
        'Zoho is not connected. Please connect Zoho from the admin panel.',
      );
    }

    if (activeConnections.length > 1) {
      throw new CompanyContextResolutionError(
        'company_context_ambiguous',
        'Multiple active company Zoho connections found; explicit company context required',
      );
    }

    return activeConnections[0].companyId;
  }
}

export const companyContextResolver = new CompanyContextResolver();
