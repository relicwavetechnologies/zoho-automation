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
  async resolveCompanyId(input?: { companyId?: unknown }): Promise<string> {
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
        'No active company Zoho connection available for retrieval',
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
