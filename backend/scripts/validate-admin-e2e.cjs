#!/usr/bin/env node

const path = require('path');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('../src/generated/prisma');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const BASE_URL = process.env.ADMIN_E2E_BASE_URL || 'http://localhost:8000';
const SUPER_ADMIN_EMAIL = process.env.E2E_SUPER_ADMIN_EMAIL || 'rdx.omega2678@gmail.com';
const SUPER_ADMIN_PASSWORD = process.env.E2E_SUPER_ADMIN_PASSWORD || 'vAbhi2678';

const prisma = new PrismaClient();

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const toErrorMessage = (error) => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const assertCondition = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const requestJson = async ({ method, pathName, token, body, expectedStatus }) => {
  const timeoutMs = Number(process.env.E2E_HTTP_TIMEOUT_MS || 10000);
  const headers = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(`${BASE_URL}${pathName}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`HTTP request failed for ${method} ${pathName}: ${toErrorMessage(error)}`);
  }

  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    const message = parsed && typeof parsed === 'object' && parsed.message ? parsed.message : raw;
    throw new Error(
      `${method} ${pathName} expected HTTP ${expectedStatus}, got ${response.status}. ${message}`,
    );
  }

  const data = parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'data')
    ? parsed.data
    : parsed;

  return {
    status: response.status,
    raw,
    parsed,
    data,
  };
};

const ensureSuperAdminCredentials = async () => {
  const existingUser = await prisma.user.findUnique({
    where: { email: SUPER_ADMIN_EMAIL },
  });

  const passwordHash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 10);

  const user = existingUser
    ? await prisma.user.update({
      where: { id: existingUser.id },
      data: {
        password: passwordHash,
        name: existingUser.name || 'Root Super Admin',
      },
    })
    : await prisma.user.create({
      data: {
        email: SUPER_ADMIN_EMAIL,
        password: passwordHash,
        name: 'Root Super Admin',
      },
    });

  const membership = await prisma.adminMembership.findFirst({
    where: {
      userId: user.id,
      role: 'SUPER_ADMIN',
      isActive: true,
    },
  });

  if (!membership) {
    await prisma.adminMembership.create({
      data: {
        userId: user.id,
        role: 'SUPER_ADMIN',
        isActive: true,
      },
    });
  }

  return user.id;
};

const cleanupRunData = async (context) => {
  const emails = [...context.createdEmails];
  const companyIds = [...context.createdCompanyIds];

  const users = emails.length
    ? await prisma.user.findMany({
      where: {
        email: {
          in: emails,
        },
      },
      select: {
        id: true,
      },
    })
    : [];

  const userIds = users.map((user) => user.id);

  if (context.previousSystemControlsPermission) {
    await prisma.rbacPermission.upsert({
      where: {
        role_action: {
          role: context.previousSystemControlsPermission.role,
          action: context.previousSystemControlsPermission.action,
        },
      },
      create: {
        role: context.previousSystemControlsPermission.role,
        action: context.previousSystemControlsPermission.action,
        allowed: context.previousSystemControlsPermission.allowed,
        updatedBy: context.previousSystemControlsPermission.updatedBy,
      },
      update: {
        allowed: context.previousSystemControlsPermission.allowed,
        updatedBy: context.previousSystemControlsPermission.updatedBy,
      },
    });
  } else {
    await prisma.rbacPermission.deleteMany({
      where: {
        role: 'COMPANY_ADMIN',
        action: 'system.controls.write',
      },
    });
  }

  if (companyIds.length || userIds.length) {
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          companyIds.length ? { companyId: { in: companyIds } } : undefined,
          userIds.length ? { actorId: { in: userIds } } : undefined,
        ].filter(Boolean),
      },
    });

    await prisma.adminControlState.deleteMany({
      where: {
        companyId: {
          in: companyIds,
        },
      },
    });

    await prisma.zohoDeltaEvent.deleteMany({
      where: {
        companyId: {
          in: companyIds,
        },
      },
    });

    await prisma.companyInvite.deleteMany({
      where: {
        companyId: {
          in: companyIds,
        },
      },
    });

    await prisma.adminSession.deleteMany({
      where: {
        OR: [
          companyIds.length ? { companyId: { in: companyIds } } : undefined,
          userIds.length ? { userId: { in: userIds } } : undefined,
        ].filter(Boolean),
      },
    });

    await prisma.adminMembership.deleteMany({
      where: {
        OR: [
          companyIds.length ? { companyId: { in: companyIds } } : undefined,
          userIds.length ? { userId: { in: userIds } } : undefined,
        ].filter(Boolean),
      },
    });

    await prisma.vectorDocument.deleteMany({
      where: {
        companyId: {
          in: companyIds,
        },
      },
    });

    await prisma.zohoSyncJobEvent.deleteMany({
      where: {
        job: {
          companyId: {
            in: companyIds,
          },
        },
      },
    });

    await prisma.zohoSyncJob.deleteMany({
      where: {
        companyId: {
          in: companyIds,
        },
      },
    });

    await prisma.zohoConnection.deleteMany({
      where: {
        companyId: {
          in: companyIds,
        },
      },
    });

    await prisma.company.deleteMany({
      where: {
        id: {
          in: companyIds,
        },
      },
    });

    await prisma.user.deleteMany({
      where: {
        id: {
          in: userIds,
        },
      },
    });
  }

  return {
    deletedUsers: userIds.length,
    deletedCompanies: companyIds.length,
    deletedEmails: emails.length,
  };
};

const runAdminE2E = async () => {
  const runId = `e2e${Date.now()}`;
  const companyAdminEmail = `${runId}.company-admin@example.com`;
  const secondCompanyAdminEmail = `${runId}.company-admin-2@example.com`;
  const inviteMemberEmail = `${runId}.member@example.com`;

  const companyAdminPassword = 'CompanyAdmin#123';
  const secondCompanyAdminPassword = 'CompanyAdmin#456';

  const report = {
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    runId,
    scenarios: [],
    ok: false,
    cleanup: null,
  };

  const context = {
    createdEmails: new Set([companyAdminEmail, secondCompanyAdminEmail, inviteMemberEmail]),
    createdCompanyIds: new Set(),
    previousSystemControlsPermission: await prisma.rbacPermission.findUnique({
      where: {
        role_action: {
          role: 'COMPANY_ADMIN',
          action: 'system.controls.write',
        },
      },
    }),
  };

  let superAdminToken;
  let companyAdminToken;
  let companyId;

  const step = async (name, fn) => {
    try {
      const detail = await fn();
      report.scenarios.push({
        name,
        status: 'PASS',
        detail,
      });
    } catch (error) {
      report.scenarios.push({
        name,
        status: 'FAIL',
        detail: toErrorMessage(error),
      });
      throw error;
    }
  };

  try {
    await step('Super-admin credential bootstrap and login', async () => {
      await ensureSuperAdminCredentials();
      const login = await requestJson({
        method: 'POST',
        pathName: '/api/admin/auth/login/super-admin',
        body: {
          email: SUPER_ADMIN_EMAIL,
          password: SUPER_ADMIN_PASSWORD,
        },
        expectedStatus: 200,
      });

      assertCondition(login.data && typeof login.data.token === 'string', 'Super-admin login token missing');
      superAdminToken = login.data.token;
      return {
        userId: login.data.session?.userId,
        role: login.data.session?.role,
      };
    });

    await step('Super-admin capabilities include workspace-only nav', async () => {
      const capabilities = await requestJson({
        method: 'GET',
        pathName: '/api/admin/auth/capabilities',
        token: superAdminToken,
        expectedStatus: 200,
      });

      const navIds = Array.isArray(capabilities.data?.navItems)
        ? capabilities.data.navItems.map((item) => item.id)
        : [];

      assertCondition(navIds.includes('workspaces'), 'Super-admin nav missing workspaces');
      assertCondition(navIds.includes('controls'), 'Super-admin nav missing controls');
      return { navIds };
    });

    await step('Company-admin self-signup and login', async () => {
      const signup = await requestJson({
        method: 'POST',
        pathName: '/api/admin/auth/signup/company-admin',
        body: {
          email: companyAdminEmail,
          password: companyAdminPassword,
          name: 'E2E Company Admin',
          companyName: `E2E Workspace ${runId}`,
        },
        expectedStatus: 201,
      });

      assertCondition(signup.data?.session?.companyId, 'Company ID missing from signup response');
      companyId = signup.data.session.companyId;
      context.createdCompanyIds.add(companyId);

      const login = await requestJson({
        method: 'POST',
        pathName: '/api/admin/auth/login/company-admin',
        body: {
          email: companyAdminEmail,
          password: companyAdminPassword,
        },
        expectedStatus: 200,
      });

      assertCondition(login.data && typeof login.data.token === 'string', 'Company-admin login token missing');
      companyAdminToken = login.data.token;
      return {
        companyId,
        userId: login.data.session?.userId,
      };
    });

    await step('Company-admin capabilities are role-scoped', async () => {
      const capabilities = await requestJson({
        method: 'GET',
        pathName: '/api/admin/auth/capabilities',
        token: companyAdminToken,
        expectedStatus: 200,
      });

      const navIds = Array.isArray(capabilities.data?.navItems)
        ? capabilities.data.navItems.map((item) => item.id)
        : [];

      assertCondition(!navIds.includes('workspaces'), 'Company-admin should not see workspaces nav');
      assertCondition(navIds.includes('members'), 'Company-admin nav missing members');
      return { navIds };
    });

    await step('RBAC backend enforcement blocks company-admin privileged mutation', async () => {
      await requestJson({
        method: 'PUT',
        pathName: '/api/admin/rbac/permissions',
        token: companyAdminToken,
        body: {
          roleId: 'COMPANY_ADMIN',
          actionId: 'audit.read',
          allowed: false,
        },
        expectedStatus: 403,
      });

      return {
        expected: 403,
      };
    });

    let createdInviteId;
    await step('Company-admin invite flow creates and accepts workspace member invite', async () => {
      const invite = await requestJson({
        method: 'POST',
        pathName: '/api/admin/company/invites',
        token: companyAdminToken,
        body: {
          email: inviteMemberEmail,
          roleId: 'MEMBER',
        },
        expectedStatus: 201,
      });

      createdInviteId = invite.data?.inviteId;
      assertCondition(typeof createdInviteId === 'string', 'Invite ID missing');

      const inviteRow = await prisma.companyInvite.findUnique({
        where: { id: createdInviteId },
      });
      assertCondition(inviteRow && inviteRow.token, 'Invite token not found for created invite');

      const accepted = await requestJson({
        method: 'POST',
        pathName: '/api/admin/auth/signup/member-invite',
        body: {
          inviteToken: inviteRow.token,
          name: 'E2E Workspace Member',
          password: 'MemberPass#123',
        },
        expectedStatus: 201,
      });

      assertCondition(accepted.data?.accepted === true, 'Invite acceptance did not return accepted=true');
      return {
        inviteId: createdInviteId,
        acceptedUserId: accepted.data?.userId,
      };
    });

    await step('Onboarding connect and sync visibility is controllable by company-admin', async () => {
      const connect = await requestJson({
        method: 'POST',
        pathName: '/api/admin/company/onboarding/connect',
        token: companyAdminToken,
        body: {
          authorizationCode: `auth-${runId}`,
          scopes: ['ZohoCRM.modules.ALL'],
          environment: 'sandbox',
        },
        expectedStatus: 202,
      });

      assertCondition(connect.data?.initialSync?.jobId, 'Initial sync job not queued');

      let lastStatus = null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const status = await requestJson({
          method: 'GET',
          pathName: '/api/admin/company/onboarding/status',
          token: companyAdminToken,
          expectedStatus: 200,
        });

        lastStatus = status.data?.historicalSync?.status || null;
        if (lastStatus === 'completed') {
          return {
            initialJobId: connect.data.initialSync.jobId,
            historicalSyncStatus: lastStatus,
            progressPercent: status.data?.historicalSync?.progressPercent,
          };
        }

        await sleep(250);
      }

      throw new Error(`Historical sync did not complete in time. Last status: ${lastStatus || 'null'}`);
    });

    await step('RBAC permission changes immediately affect authorization outcomes', async () => {
      await requestJson({
        method: 'PUT',
        pathName: '/api/admin/rbac/permissions',
        token: superAdminToken,
        body: {
          roleId: 'COMPANY_ADMIN',
          actionId: 'system.controls.write',
          allowed: false,
        },
        expectedStatus: 200,
      });

      await requestJson({
        method: 'GET',
        pathName: '/api/admin/runtime/tasks?limit=5',
        token: companyAdminToken,
        expectedStatus: 403,
      });

      await requestJson({
        method: 'PUT',
        pathName: '/api/admin/rbac/permissions',
        token: superAdminToken,
        body: {
          roleId: 'COMPANY_ADMIN',
          actionId: 'system.controls.write',
          allowed: true,
        },
        expectedStatus: 200,
      });

      await requestJson({
        method: 'GET',
        pathName: '/api/admin/runtime/tasks?limit=5',
        token: companyAdminToken,
        expectedStatus: 200,
      });

      return {
        permissionToggled: 'COMPANY_ADMIN:system.controls.write false -> true',
      };
    });

    await step('Company-admin company scope boundary is enforced on backend', async () => {
      await requestJson({
        method: 'POST',
        pathName: '/api/admin/auth/signup/company-admin',
        body: {
          email: secondCompanyAdminEmail,
          password: secondCompanyAdminPassword,
          name: 'E2E Company Admin 2',
          companyName: `E2E Workspace 2 ${runId}`,
        },
        expectedStatus: 201,
      });

      const secondLogin = await requestJson({
        method: 'POST',
        pathName: '/api/admin/auth/login/company-admin',
        body: {
          email: secondCompanyAdminEmail,
          password: secondCompanyAdminPassword,
        },
        expectedStatus: 200,
      });

      const secondCompanyId = secondLogin.data?.session?.companyId;
      if (secondCompanyId) {
        context.createdCompanyIds.add(secondCompanyId);
      }

      await requestJson({
        method: 'GET',
        pathName: `/api/admin/company/members?companyId=${encodeURIComponent(companyId)}`,
        token: secondLogin.data?.token,
        expectedStatus: 403,
      });

      return {
        attemptedCompanyId: companyId,
        secondCompanyId,
      };
    });

    await step('Audit log visibility includes RBAC and invite mutation trails', async () => {
      const inviteLogs = await requestJson({
        method: 'GET',
        pathName: '/api/admin/audit/logs?action=admin.invite.create&limit=50',
        token: superAdminToken,
        expectedStatus: 200,
      });

      const rbacLogs = await requestJson({
        method: 'GET',
        pathName: '/api/admin/audit/logs?action=admin.rbac.permission_update&limit=50',
        token: superAdminToken,
        expectedStatus: 200,
      });

      const inviteCount = Array.isArray(inviteLogs.data) ? inviteLogs.data.length : 0;
      const rbacCount = Array.isArray(rbacLogs.data) ? rbacLogs.data.length : 0;

      assertCondition(inviteCount > 0, 'No invite audit logs found');
      assertCondition(rbacCount > 0, 'No RBAC permission update audit logs found');

      return {
        inviteAuditRows: inviteCount,
        rbacAuditRows: rbacCount,
      };
    });

    report.ok = true;
  } catch {
    report.ok = false;
  } finally {
    try {
      report.cleanup = await cleanupRunData(context);
    } catch (cleanupError) {
      report.cleanup = {
        error: toErrorMessage(cleanupError),
      };
      report.ok = false;
    }

    report.finishedAt = new Date().toISOString();
  }

  return report;
};

if (require.main === module) {
  runAdminE2E()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    })
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: toErrorMessage(error) }, null, 2));
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

module.exports = {
  runAdminE2E,
};
