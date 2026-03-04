import jwt from 'jsonwebtoken';

import config from '../../config';
import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import type {
  AdminNavItemDTO,
  AdminSessionDTO,
  SuperAdminBootstrapDTO,
} from '../../emiac/contracts';
import { comparePassword, hashPassword } from '../../utils/bcrypt';
import { AdminLoginResult } from './admin-auth.model';
import { AdminAuthRepository, adminAuthRepository } from './admin-auth.repository';
import { BootstrapSuperAdminDto } from './dto/bootstrap-super-admin.dto';
import { GrantCompanyAdminDto } from './dto/grant-company-admin.dto';
import { LoginCompanyAdminDto } from './dto/login-company-admin.dto';
import { LoginSuperAdminDto } from './dto/login-super-admin.dto';

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

    return this.issueSession(user.id, 'COMPANY_ADMIN', payload.companyId);
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
        id: 'companies',
        label: 'Companies',
        path: '/companies',
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
