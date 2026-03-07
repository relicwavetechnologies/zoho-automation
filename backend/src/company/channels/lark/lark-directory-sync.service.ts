import config from '../../../config';
import { logger } from '../../../utils/logger';
import { channelIdentityRepository } from '../channel-identity.repository';
import { larkDirectorySyncRepository } from './lark-directory-sync.repository';
import { larkTenantBindingRepository } from './lark-tenant-binding.repository';
import { LarkTenantTokenService } from './lark-tenant-token.service';
import { larkWorkspaceConfigRepository } from './lark-workspace-config.repository';

type LarkDirectorySyncTrigger = 'setup' | 'nightly' | 'manual';

type LarkUserRecord = {
  externalUserId: string;
  openId?: string;
  userId?: string;
  name?: string;
  email?: string;
  sourceRoles: string[];
  isAdminDefault: boolean;
};

class LarkDirectorySyncError extends Error {
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

const NIGHTLY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 50;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const readString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const readBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') {
    return value;
  }
  return undefined;
};

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const readItems = (payload: Record<string, unknown>): Record<string, unknown>[] => {
  const data = asRecord(payload.data) ?? {};
  const candidate = asArray(data.items).length > 0
    ? asArray(data.items)
    : asArray(data.user_list).length > 0
      ? asArray(data.user_list)
      : asArray(data.members).length > 0
        ? asArray(data.members)
        : asArray(data.role_list).length > 0
          ? asArray(data.role_list)
          : asArray(data.roles);
  return candidate.map((item) => asRecord(item)).filter(Boolean) as Record<string, unknown>[];
};

const readNextPageToken = (payload: Record<string, unknown>): string | undefined => {
  const data = asRecord(payload.data) ?? {};
  return readString(data.page_token);
};

const readHasMore = (payload: Record<string, unknown>): boolean => {
  const data = asRecord(payload.data) ?? {};
  return readBoolean(data.has_more) ?? false;
};

const isAdminRoleName = (roleName: string): boolean =>
  /(admin|administrator|owner|manager|tenant_admin|tenant_manager)/i.test(roleName);

const buildPermissionHint = (code?: number, message?: string): string => {
  if (code === 99991672) {
    return `${message ?? 'No permission'}. Enable Lark permission "Access role information" or functional role read scope, then publish/reinstall app.`;
  }
  return message ?? 'Unknown Lark error';
};

const toQueryString = (params: Record<string, string | number | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && `${value}`.length > 0) {
      query.set(key, String(value));
    }
  }
  return query.toString();
};

class LarkDirectorySyncService {
  private readonly inFlight = new Map<string, Promise<void>>();

  async trigger(companyId: string, trigger: LarkDirectorySyncTrigger) {
    const existing = await larkDirectorySyncRepository.findRunningRun(companyId);
    if (existing) {
      return {
        runId: existing.id,
        status: existing.status,
        queued: false,
      };
    }

    const run = await larkDirectorySyncRepository.createRun({
      companyId,
      trigger,
      status: 'running',
    });

    const execution = this.execute(companyId, run.id, trigger).finally(() => {
      this.inFlight.delete(companyId);
    });
    this.inFlight.set(companyId, execution);
    void execution;

    return {
      runId: run.id,
      status: 'running',
      queued: true,
    };
  }

  async getStatus(companyId: string) {
    const run = await larkDirectorySyncRepository.findLatestRun(companyId);
    if (!run) {
      return {
        hasRun: false,
      };
    }

    return {
      hasRun: true,
      runId: run.id,
      trigger: run.trigger,
      status: run.status,
      syncedCount: run.syncedCount,
      adminCount: run.adminCount,
      memberCount: run.memberCount,
      errorMessage: run.errorMessage ?? undefined,
      diagnostics: run.diagnostics ?? undefined,
      startedAt: run.startedAt?.toISOString(),
      finishedAt: run.finishedAt?.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    };
  }

  async runNightlySyncForAll() {
    const companyIds = await larkWorkspaceConfigRepository.listConfiguredCompanyIds();
    for (const companyId of companyIds) {
      try {
        await this.trigger(companyId, 'nightly');
      } catch (error) {
        logger.warn('lark.directory.sync.nightly_enqueue_failed', {
          companyId,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      }
    }
  }

  private async execute(companyId: string, runId: string, trigger: LarkDirectorySyncTrigger) {
    try {
      const binding = (await larkTenantBindingRepository.listByCompany(companyId)).find((row) => row.isActive);
      if (!binding) {
        throw new Error('Active Lark tenant binding is required before syncing users');
      }

      const workspaceConfig = await larkWorkspaceConfigRepository.findByCompanyId(companyId);
      if (!workspaceConfig) {
        throw new Error('Lark workspace config is not configured for this company');
      }

      const tokenSource = workspaceConfig.staticTenantAccessToken ? 'workspace_static_token' : 'workspace_app_credentials';
      logger.info('lark.directory.sync.token_strategy', {
        companyId,
        trigger,
        tokenSource,
        appId: workspaceConfig.appId,
        staticFallbackEnabled: Boolean(workspaceConfig.staticTenantAccessToken),
      });

      const tokenService = new LarkTenantTokenService({
        apiBaseUrl: workspaceConfig.apiBaseUrl,
        appId: workspaceConfig.appId,
        appSecret: workspaceConfig.appSecret,
        staticToken: workspaceConfig.staticTenantAccessToken,
      });

      const token = await tokenService.getAccessToken();

      let users: Map<string, LarkUserRecord>;
      try {
        users = await this.listUsersDirectly(workspaceConfig.apiBaseUrl, token);
      } catch (error) {
        logger.warn('lark.directory.sync.users.list_strategy_failed', {
          companyId,
          trigger,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
        users = await this.listUsersByDepartment(workspaceConfig.apiBaseUrl, token);
      }

      await this.enrichRoles(workspaceConfig.apiBaseUrl, token, users, workspaceConfig.appId);

      const userRecords = [...users.values()];
      let adminCount = 0;
      let memberCount = 0;

      for (const user of userRecords) {
        const defaultAiRole = user.isAdminDefault ? 'COMPANY_ADMIN' : 'MEMBER';
        if (defaultAiRole === 'COMPANY_ADMIN') {
          adminCount += 1;
        } else {
          memberCount += 1;
        }

        await channelIdentityRepository.upsert({
          channel: 'lark',
          externalUserId: user.externalUserId,
          externalTenantId: binding.larkTenantKey,
          companyId,
          displayName: user.name,
          email: user.email,
          larkOpenId: user.openId,
          larkUserId: user.userId,
          sourceRoles: user.sourceRoles,
          aiRole: defaultAiRole,
        });
      }

      await larkDirectorySyncRepository.markCompleted(runId, {
        syncedCount: userRecords.length,
        adminCount,
        memberCount,
        diagnostics: {
          tokenSource,
          activeTenantKey: binding.larkTenantKey,
        },
      });

      logger.info('lark.directory.sync.completed', {
        companyId,
        trigger,
        syncedCount: userRecords.length,
        adminCount,
        memberCount,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown_error';
      await larkDirectorySyncRepository.markFailed(runId, reason);
      logger.error('lark.directory.sync.failed', {
        companyId,
        trigger,
        reason,
      });
    }
  }

  private async listUsersDirectly(apiBaseUrl: string, token: string) {
    const users = new Map<string, LarkUserRecord>();
    let pageToken: string | undefined;

    for (;;) {
      const query = toQueryString({
        page_size: MAX_PAGE_SIZE,
        page_token: pageToken,
        user_id_type: 'open_id',
      });
      const payload = await this.requestJson(
        apiBaseUrl,
        token,
        `/open-apis/contact/v3/users?${query}`,
        'Lark users.list',
      );
      const items = readItems(payload);
      for (const item of items) {
        this.mergeUser(users, item);
      }
      pageToken = readHasMore(payload) ? readNextPageToken(payload) : undefined;
      if (!pageToken) {
        break;
      }
    }

    logger.info('lark.directory.sync.users.list_strategy', {
      syncedCount: users.size,
    });

    return users;
  }

  private async listUsersByDepartment(apiBaseUrl: string, token: string) {
    const users = new Map<string, LarkUserRecord>();
    const rootOpenDepartmentId = '0';
    const departments = new Set<string>([rootOpenDepartmentId]);
    const queue = [rootOpenDepartmentId];

    try {
      logger.info('lark.directory.sync.department_tree.list_strategy', {
        rootOpenDepartmentId,
      });

      while (queue.length > 0) {
        const parentDepartmentId = queue.shift()!;
        let pageToken: string | undefined;

        for (;;) {
          const query = toQueryString({
            department_id_type: 'open_department_id',
            page_size: MAX_PAGE_SIZE,
            page_token: pageToken,
          });
          const payload = await this.requestJson(
            apiBaseUrl,
            token,
            `/open-apis/contact/v3/departments/${encodeURIComponent(parentDepartmentId)}/children?${query}`,
            'Lark departments.children',
          );
          const items = readItems(payload);
          for (const item of items) {
            const departmentId =
              readString(item.open_department_id)
              ?? readString(item.department_id)
              ?? readString(item.id);
            if (departmentId && !departments.has(departmentId)) {
              departments.add(departmentId);
              queue.push(departmentId);
            }
          }
          pageToken = readHasMore(payload) ? readNextPageToken(payload) : undefined;
          if (!pageToken) {
            break;
          }
        }
      }
      logger.info('lark.directory.sync.department_tree.summary', {
        rootOpenDepartmentId,
        departmentCount: departments.size,
      });
    } catch (error) {
      logger.warn('lark.directory.sync.department_tree_failed', {
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
    }

    for (const departmentId of departments) {
      let pageToken: string | undefined;
      for (;;) {
        const query = toQueryString({
          department_id: departmentId,
          department_id_type: 'open_department_id',
          page_size: MAX_PAGE_SIZE,
          page_token: pageToken,
          user_id_type: 'open_id',
        });
        const payload = await this.requestJson(
          apiBaseUrl,
          token,
          `/open-apis/contact/v3/users/find_by_department?${query}`,
          'Lark users.find_by_department',
        );
        const items = readItems(payload);
        for (const item of items) {
          this.mergeUser(users, item);
        }
        pageToken = readHasMore(payload) ? readNextPageToken(payload) : undefined;
        if (!pageToken) {
          break;
        }
      }
    }

    return users;
  }

  private async enrichRoles(
    apiBaseUrl: string,
    token: string,
    users: Map<string, LarkUserRecord>,
    appId: string,
  ) {
    const roleMap = new Map<string, Set<string>>();
    try {
      const roles = await this.listRoles(apiBaseUrl, token);
      for (const role of roles) {
        let pageToken: string | undefined;
        for (;;) {
          const query = toQueryString({
            page_size: MAX_PAGE_SIZE,
            page_token: pageToken,
            user_id_type: 'open_id',
          });
          const payload = await this.requestJson(
            apiBaseUrl,
            token,
            role.version === 'v3'
              ? `/open-apis/contact/v3/functional_roles/${encodeURIComponent(role.id)}/members?${query}`
              : `/open-apis/contact/v2/role/members?role_id=${encodeURIComponent(role.id)}&${query}`,
            role.version === 'v3' ? 'Lark functional_roles.members' : 'Lark role.members',
          );
          const items = readItems(payload);
          for (const item of items) {
            const openId = readString(item.open_id) ?? readString(item.user_id);
            if (!openId) {
              continue;
            }
            if (!roleMap.has(openId)) {
              roleMap.set(openId, new Set<string>());
            }
            roleMap.get(openId)!.add(role.name);
          }
          pageToken = readHasMore(payload) ? readNextPageToken(payload) : undefined;
          if (!pageToken) {
            break;
          }
        }
      }
    } catch (error) {
      const code = error instanceof LarkDirectorySyncError ? error.code : undefined;
      logger.warn('lark.directory.sync.role_membership_enrichment_failed', {
        reason: buildPermissionHint(code, error instanceof Error ? error.message : 'unknown_error'),
        tokenSource: '[REDACTED]',
        appId,
      });
      return;
    }

    logger.info('lark.directory.sync.role_membership_enrichment_summary', {
      appId,
      enrichedUsers: [...users.values()].filter((user) => user.sourceRoles.length > 0).length,
    });

    for (const user of users.values()) {
      const roleNames = [...(roleMap.get(user.openId ?? user.externalUserId) ?? new Set<string>())];
      if (roleNames.length > 0) {
        user.sourceRoles = [...new Set([...user.sourceRoles, ...roleNames])];
      }
      if (user.sourceRoles.some((roleName) => isAdminRoleName(roleName))) {
        user.isAdminDefault = true;
      }
    }
  }

  private async listRoles(apiBaseUrl: string, token: string): Promise<Array<{ id: string; name: string; version: 'v2' | 'v3' }>> {
    try {
      let pageToken: string | undefined;
      const roles: Array<{ id: string; name: string; version: 'v2' | 'v3' }> = [];
      for (;;) {
        const query = toQueryString({
          page_size: MAX_PAGE_SIZE,
          page_token: pageToken,
        });
        const payload = await this.requestJson(
          apiBaseUrl,
          token,
          `/open-apis/contact/v3/functional_roles?${query}`,
          'Lark functional_roles.list',
        );
        const items = readItems(payload);
        for (const item of items) {
          const roleId = readString(item.role_id);
          const roleName = readString(item.role_name);
          if (roleId && roleName) {
            roles.push({ id: roleId, name: roleName, version: 'v3' });
          }
        }
        pageToken = readHasMore(payload) ? readNextPageToken(payload) : undefined;
        if (!pageToken) {
          return roles;
        }
      }
    } catch (error) {
      const payload = await this.requestJson(apiBaseUrl, token, '/open-apis/contact/v2/role/list', 'Lark roles.list');
      const items = readItems(payload);
      return items
        .map((item) => {
          const roleId = readString(item.role_id);
          const roleName = readString(item.role_name);
          if (!roleId || !roleName) {
            return null;
          }
          return { id: roleId, name: roleName, version: 'v2' as const };
        })
        .filter(Boolean) as Array<{ id: string; name: string; version: 'v2' | 'v3' }>;
    }
  }

  private mergeUser(users: Map<string, LarkUserRecord>, item: Record<string, unknown>) {
    const openId =
      readString(item.open_id)
      ?? readString(asRecord(item.user_id)?.open_id)
      ?? readString(asRecord(item.user)?.open_id);
    const userId =
      readString(item.user_id)
      ?? readString(asRecord(item.user_id)?.user_id)
      ?? readString(asRecord(item.user)?.user_id);
    const externalUserId = openId ?? userId;
    if (!externalUserId) {
      return;
    }

    const current = users.get(externalUserId) ?? {
      externalUserId,
      sourceRoles: [],
      isAdminDefault: false,
    };

    const name =
      readString(item.name)
      ?? readString(item.en_name)
      ?? readString(item.nickname)
      ?? current.name;
    const email = readString(item.email) ?? current.email;
    const sourceRoles = [...new Set(current.sourceRoles)];
    const isTenantManager = readBoolean(item.is_tenant_manager) === true;
    const isTenantAdmin = readBoolean(item.is_tenant_admin) === true;
    if (isTenantManager) {
      sourceRoles.push('tenant_manager');
    }
    if (isTenantAdmin) {
      sourceRoles.push('tenant_admin');
    }

    users.set(externalUserId, {
      externalUserId,
      openId: openId ?? current.openId,
      userId: userId ?? current.userId,
      name,
      email,
      sourceRoles: [...new Set(sourceRoles)],
      isAdminDefault: current.isAdminDefault || isTenantManager || isTenantAdmin,
    });
  }

  private async requestJson(
    apiBaseUrl: string,
    token: string,
    path: string,
    label: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    } catch (error) {
      throw new LarkDirectorySyncError(
        `${label} network request failed: ${error instanceof Error ? error.message : 'unknown_error'}`,
      );
    }

    const payload = asRecord(await response.json().catch(() => ({}))) ?? {};
    const code = readNumber(payload.code);
    const message = readString(payload.msg) ?? response.statusText;

    if (!response.ok || (code !== undefined && code !== 0)) {
      throw new LarkDirectorySyncError(`${label} request failed (${code ?? response.status}) code=${String(code)} msg=${message}`, code);
    }

    return payload;
  }
}

class LarkDirectorySyncScheduler {
  private timer: NodeJS.Timeout | null = null;

  start() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void larkDirectorySyncService.runNightlySyncForAll();
    }, NIGHTLY_INTERVAL_MS);
    this.timer.unref?.();
    logger.info('lark.directory.sync.scheduler.started', {
      intervalMs: NIGHTLY_INTERVAL_MS,
      nodeEnv: config.NODE_ENV,
    });
  }

  stop() {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }
}

export const larkDirectorySyncService = new LarkDirectorySyncService();
export const larkDirectorySyncScheduler = new LarkDirectorySyncScheduler();
