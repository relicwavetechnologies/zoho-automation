import jwt from 'jsonwebtoken';

import config from '../../config';
import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import { Prisma } from '../../generated/prisma';
import type {
  AdminNavItemDTO,
  AdminSessionDTO,
  SuperAdminBootstrapDTO,
} from '../../company/contracts';
import { comparePassword, hashPassword } from '../../utils/bcrypt';
import { AdminLoginResult } from './admin-auth.model';
import { AdminAuthRepository, adminAuthRepository } from './admin-auth.repository';
import { BootstrapSuperAdminDto } from './dto/bootstrap-super-admin.dto';
import { GrantCompanyAdminDto } from './dto/grant-company-admin.dto';
import { LoginCompanyAdminDto } from './dto/login-company-admin.dto';
import { LoginSuperAdminDto } from './dto/login-super-admin.dto';
import { SignupCompanyAdminDto } from './dto/signup-company-admin.dto';
import { SignupMemberInviteDto } from './dto/signup-member-invite.dto';

const buildSessionExpiry = (): Date =>
  new Date(Date.now() + config.ADMIN_SESSION_TTL_MINUTES * 60 * 1000);

export class AdminAuthService extends BaseService {
  constructor(private readonly repository: AdminAuthRepository = adminAuthRepository) {
    super();
  }

  async bootstrapSuperAdmin(payload: BootstrapSuperAdminDto): Promise<SuperAdminBootstrapDTO> {
    const existingSuperAdminCount = await this.repository.countActiveSuperAdmins();
    if (existingSuperAdminCount > 0) {
      throw new HttpException(409, 'Super-admin bootstrap already completed');
    }

    const existingUser = await this.repository.findUserByEmail(payload.email);
    if (existingUser) {
      throw new HttpException(409, 'Bootstrap email already exists');
    }

    const hashedPassword = await hashPassword(payload.password);
    const user = await this.repository.createUser({
      email: payload.email,
      password: hashedPassword,
      name: payload.name,
    });

    await this.repository.createAdminMembership({
      userId: user.id,
      role: 'SUPER_ADMIN',
    });

    return {
      email: payload.email,
      password: payload.password,
      name: payload.name,
    };
  }

  async loginSuperAdmin(payload: LoginSuperAdminDto): Promise<AdminLoginResult> {
    const user = await this.repository.findUserByEmail(payload.email);
    if (!user) {
      throw new HttpException(401, 'Invalid credentials');
    }

    const validPassword = await comparePassword(payload.password, user.password);
    if (!validPassword) {
      throw new HttpException(401, 'Invalid credentials');
    }

    const membership = await this.repository.findActiveMembership({
      userId: user.id,
      role: 'SUPER_ADMIN',
    });

    if (!membership) {
      throw new HttpException(403, 'User is not an active super-admin');
    }

    return this.issueSession(user.id, 'SUPER_ADMIN');
  }

  async loginCompanyAdmin(payload: LoginCompanyAdminDto): Promise<AdminLoginResult> {
    const user = await this.repository.findUserByEmail(payload.email);
    if (!user) {
      throw new HttpException(401, 'Invalid credentials');
    }

    const validPassword = await comparePassword(payload.password, user.password);
    if (!validPassword) {
      throw new HttpException(401, 'Invalid credentials');
    }

    const membership = await this.repository.findActiveMembership({
      userId: user.id,
      role: 'COMPANY_ADMIN',
      companyId: payload.companyId,
    });

    if (!membership) {
      throw new HttpException(403, 'User is not an active company-admin for this company');
    }

    if (!membership.companyId) {
      throw new HttpException(500, 'Company-admin membership missing company scope');
    }

    return this.issueSession(user.id, 'COMPANY_ADMIN', membership.companyId);
  }

  async signupCompanyAdmin(payload: SignupCompanyAdminDto): Promise<AdminLoginResult> {
    const hashedPassword = await hashPassword(payload.password);
    let userId: string;
    let companyId: string;
    try {
      const result = await this.repository.createCompanyAdminSignup({
        email: payload.email,
        password: hashedPassword,
        name: payload.name,
        companyName: payload.companyName,
      });
      userId = result.user.id;
      companyId = result.company.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new HttpException(409, 'Email already exists');
      }
      throw error;
    }

    return this.issueSession(userId, 'COMPANY_ADMIN', companyId);
  }

  async signupFromInvite(payload: SignupMemberInviteDto): Promise<{
    accepted: true;
    role: string;
    companyId: string;
    userId: string;
    email: string;
  }> {
    const invite = await this.repository.findInviteByToken(payload.inviteToken);
    if (!invite) {
      throw new HttpException(404, 'Invite token not found');
    }

    if (invite.status !== 'pending') {
      throw new HttpException(409, 'Invite is no longer active');
    }

    if (invite.expiresAt.getTime() < Date.now()) {
      throw new HttpException(410, 'Invite has expired');
    }

    const hashedPassword = await hashPassword(payload.password);
    const existingUser = await this.repository.findUserByEmail(invite.email);
    const user = existingUser
      ? await this.repository.updateUserPasswordAndName(existingUser.id, {
        password: hashedPassword,
        name: payload.name,
      })
      : await this.repository.createUser({
        email: invite.email,
        password: hashedPassword,
        name: payload.name,
      });

    await this.repository.upsertMembership(user.id, invite.companyId, invite.role);
    await this.repository.acceptInvite(invite.id);

    return {
      accepted: true,
      role: invite.role,
      companyId: invite.companyId,
      userId: user.id,
      email: user.email,
    };
  }

  async resolveAdminSession(sessionId: string): Promise<AdminSessionDTO | null> {
    const session = await this.repository.findActiveSessionBySessionId(sessionId);
    if (!session || session.revokedAt) {
      return null;
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    return {
      userId: session.userId,
      companyId: session.companyId ?? undefined,
      role: session.role as AdminSessionDTO['role'],
      sessionId: session.sessionId,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  async grantCompanyAdminMembership(payload: GrantCompanyAdminDto): Promise<{
    userId: string;
    companyId: string;
    role: 'COMPANY_ADMIN';
  }> {
    const [user, company] = await Promise.all([
      this.repository.findUserById(payload.userId),
      this.repository.findCompanyById(payload.companyId),
    ]);

    if (!user) {
      throw new HttpException(404, 'User not found');
    }

    if (!company) {
      throw new HttpException(404, 'Company not found');
    }

    await this.repository.upsertCompanyAdminMembership(payload.userId, payload.companyId);
    return {
      userId: payload.userId,
      companyId: payload.companyId,
      role: 'COMPANY_ADMIN',
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.repository.revokeSession(sessionId);
  }

  getCapabilities(session: AdminSessionDTO): { navItems: AdminNavItemDTO[] } {
    const allItems: AdminNavItemDTO[] = [
      {
        id: 'overview',
        label: 'Overview',
        path: '/overview',
        roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'],
      },
      {
        id: 'workspaces',
        label: 'Workspaces',
        path: '/workspaces',
        roles: ['SUPER_ADMIN'],
      },
      {
        id: 'members',
        label: 'Members',
        path: '/members',
        roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'],
      },
      {
        id: 'rbac',
        label: 'RBAC',
        path: '/rbac',
        roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'],
      },
      {
        id: 'audit',
        label: 'Audit Logs',
        path: '/audit',
        roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'],
      },
      {
        id: 'controls',
        label: 'System Controls',
        path: '/controls',
        roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'],
      },
      {
        id: 'ai-models',
        label: 'AI Models',
        path: '/ai-models',
        roles: ['SUPER_ADMIN'],
      },
      {
        id: 'integrations',
        label: 'Integrations',
        path: '/integrations',
        roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'],
      },
      {
        id: 'tool-access',
        label: 'Tool Access',
        path: '/tool-access',
        roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'],
      },
    ];

    return {
      navItems: allItems.filter((item) => item.roles.includes(session.role)),
    };
  }

  private async issueSession(
    userId: string,
    role: AdminSessionDTO['role'],
    companyId?: string,
  ): Promise<AdminLoginResult> {
    const expiresAt = buildSessionExpiry();
    const session = await this.repository.createAdminSession({
      userId,
      role,
      companyId,
      expiresAt,
    });

    const sessionDto: AdminSessionDTO = {
      userId: session.userId,
      companyId: session.companyId ?? undefined,
      role: session.role as AdminSessionDTO['role'],
      sessionId: session.sessionId,
      expiresAt: session.expiresAt.toISOString(),
    };

    const token = jwt.sign(
      {
        userId: session.userId,
        sessionId: session.sessionId,
        role: session.role,
        companyId: session.companyId ?? undefined,
      },
      config.ADMIN_JWT_SECRET,
      { expiresIn: `${config.ADMIN_SESSION_TTL_MINUTES}m` },
    );

    return {
      token,
      session: sessionDto,
    };
  }
}

export const adminAuthService = new AdminAuthService();
