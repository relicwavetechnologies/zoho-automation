import { randomUUID } from 'crypto';

import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import { auditService } from '../audit/audit.service';
import { CompanyAdminRepository, companyAdminRepository } from './company-admin.repository';
import { CreateInviteDto } from './dto/create-invite.dto';

export type SessionScope = {
  userId: string;
  role: 'SUPER_ADMIN' | 'COMPANY_ADMIN';
  companyId?: string;
};

const resolveCompanyScope = (session: SessionScope, requestedCompanyId?: string): string => {
  if (session.role === 'SUPER_ADMIN') {
    if (!requestedCompanyId) {
      throw new HttpException(400, 'companyId is required for super-admin company operations');
    }
    return requestedCompanyId;
  }

  if (!session.companyId) {
    throw new HttpException(403, 'Company-admin session missing company scope');
  }

  if (requestedCompanyId && requestedCompanyId !== session.companyId) {
    throw new HttpException(403, 'Company scope mismatch');
  }

  return session.companyId;
};

export class CompanyAdminService extends BaseService {
  constructor(private readonly repository: CompanyAdminRepository = companyAdminRepository) {
    super();
  }

  async listMembers(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const rows = await this.repository.listMembers(scopedCompanyId);

    return rows.map((row) => ({
      userId: row.userId,
      companyId: row.companyId,
      roleId: row.role,
      email: row.user.email,
      name: row.user.name,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async createInvite(session: SessionScope, payload: CreateInviteDto) {
    const scopedCompanyId = resolveCompanyScope(session, payload.companyId);
    const company = await this.repository.findCompany(scopedCompanyId);
    if (!company) {
      throw new HttpException(404, 'Company not found');
    }

    const invite = await this.repository.createInvite({
      companyId: scopedCompanyId,
      email: payload.email,
      role: payload.roleId,
      token: randomUUID(),
      invitedBy: session.userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'admin.invite.create',
      outcome: 'success',
      metadata: {
        inviteId: invite.id,
        email: invite.email,
      },
    });

    return {
      inviteId: invite.id,
      companyId: invite.companyId,
      email: invite.email,
      roleId: invite.role,
      status: invite.status,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  async listInvites(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const rows = await this.repository.listInvites(scopedCompanyId);

    return rows.map((row) => ({
      inviteId: row.id,
      companyId: row.companyId,
      email: row.email,
      roleId: row.role,
      status: row.status,
      invitedBy: row.invitedBy,
      expiresAt: row.expiresAt.toISOString(),
      acceptedAt: row.acceptedAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async cancelInvite(session: SessionScope, inviteId: string) {
    const invite = await this.repository.findInvite(inviteId);
    if (!invite) {
      throw new HttpException(404, 'Invite not found');
    }

    resolveCompanyScope(session, invite.companyId);

    if (invite.status !== 'pending') {
      throw new HttpException(409, 'Only pending invites can be cancelled');
    }

    const cancelled = await this.repository.cancelInvite(inviteId);
    await auditService.recordLog({
      actorId: session.userId,
      companyId: cancelled.companyId,
      action: 'admin.invite.cancel',
      outcome: 'success',
      metadata: {
        inviteId,
      },
    });

    return {
      inviteId: cancelled.id,
      status: cancelled.status,
    };
  }
}

export const companyAdminService = new CompanyAdminService();
