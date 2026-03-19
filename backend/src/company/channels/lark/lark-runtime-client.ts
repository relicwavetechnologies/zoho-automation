import config from '../../../config';
import { logger } from '../../../utils/logger';
import { companyContextResolver } from '../../agents/support/company-context.resolver';
import { larkOAuthService } from './lark-oauth.service';
import { larkUserAuthLinkRepository } from './lark-user-auth-link.repository';
import { LarkTenantTokenService } from './lark-tenant-token.service';
import { larkWorkspaceConfigRepository, type DecryptedLarkWorkspaceConfig } from './lark-workspace-config.repository';

export type LarkCredentialMode = 'tenant' | 'user_linked';

type LarkRequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type LarkRuntimeClientOptions = {
  fetchImpl?: typeof fetch;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
};

export type LarkRuntimeRequestInput = {
  companyId?: string;
  larkTenantKey?: string;
  appUserId?: string;
  credentialMode?: LarkCredentialMode;
  method: LarkRequestMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
};

export class LarkRuntimeClientError extends Error {
  readonly code: 'lark_runtime_unavailable' | 'lark_runtime_invalid_response';

  constructor(message: string, code: 'lark_runtime_unavailable' | 'lark_runtime_invalid_response') {
    super(message);
    this.code = code;
  }
}

export const readLarkRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

export const readLarkArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const readLarkString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const readLarkNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

export const readLarkBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const readErrorMessage = (payload: Record<string, unknown>): string =>
  readLarkString(payload.msg) ?? readLarkString(payload.message) ?? 'Unknown Lark API error';

const appendQuery = (
  url: URL,
  query?: Record<string, string | number | boolean | undefined | null>,
): void => {
  if (!query) {
    return;
  }

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    const normalized = typeof value === 'string' ? value.trim() : String(value);
    if (normalized.length === 0) {
      continue;
    }
    url.searchParams.set(key, normalized);
  }
};

export class LarkRuntimeClient {
  private readonly fetchImpl: typeof fetch;

  private readonly log: Pick<typeof logger, 'info' | 'warn' | 'error'>;

  constructor(options: LarkRuntimeClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? logger;
  }

  async requestJson<T = Record<string, unknown>>(input: LarkRuntimeRequestInput): Promise<{
    companyId: string;
    workspaceConfig: DecryptedLarkWorkspaceConfig | null;
    payload: T;
    data: Record<string, unknown>;
  }> {
    const companyId = await companyContextResolver.resolveCompanyId({
      companyId: input.companyId,
      larkTenantKey: input.larkTenantKey,
    });
    this.log.info('lark.runtime.request.start', {
      companyId,
      method: input.method,
      path: input.path,
      credentialMode: input.credentialMode ?? 'tenant',
      appUserId: input.appUserId ?? null,
      hasLarkTenantKey: Boolean(input.larkTenantKey),
    });
    const workspaceConfig = await larkWorkspaceConfigRepository.findByCompanyId(companyId);
    const apiBaseUrl = workspaceConfig?.apiBaseUrl ?? config.LARK_API_BASE_URL;
    const accessToken = input.credentialMode === 'user_linked'
      ? await this.resolveUserLinkedAccessToken({
        appUserId: input.appUserId,
        companyId,
        larkTenantKey: input.larkTenantKey,
      })
      : await this.buildTokenService(workspaceConfig).getAccessToken();

    const url = new URL(`${apiBaseUrl}${input.path}`);
    appendQuery(url, input.query);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(input.headers ?? {}),
        },
        body: input.body === undefined
          ? undefined
          : typeof input.body === 'string'
            ? input.body
            : JSON.stringify(input.body),
      });
    } catch (error) {
      throw new LarkRuntimeClientError(
        `Lark request failed: ${error instanceof Error ? error.message : 'unknown_network_error'}`,
        'lark_runtime_unavailable',
      );
    }

    let payload: unknown = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    const record = readLarkRecord(payload) ?? {};
    const code = readLarkNumber(record.code);

    if (!response.ok || (code !== undefined && code !== 0)) {
      this.log.error('lark.runtime.request.failed', {
        companyId,
        method: input.method,
        path: input.path,
        statusCode: response.status,
        code,
        msg: readErrorMessage(record),
      });
      throw new LarkRuntimeClientError(
        `Lark request failed (${response.status}): ${readErrorMessage(record)}`,
        'lark_runtime_unavailable',
      );
    }

    this.log.info('lark.runtime.request.success', {
      companyId,
      method: input.method,
      path: input.path,
      statusCode: response.status,
    });

    return {
      companyId,
      workspaceConfig,
      payload: record as T,
      data: readLarkRecord(record.data) ?? {},
    };
  }

  private buildTokenService(workspaceConfig: DecryptedLarkWorkspaceConfig | null) {
    return new LarkTenantTokenService({
      apiBaseUrl: workspaceConfig?.apiBaseUrl ?? config.LARK_API_BASE_URL,
      appId: workspaceConfig?.appId ?? config.LARK_APP_ID,
      appSecret: workspaceConfig?.appSecret ?? config.LARK_APP_SECRET,
      staticToken: workspaceConfig?.staticTenantAccessToken ?? config.LARK_BOT_TENANT_ACCESS_TOKEN,
      fetchImpl: this.fetchImpl,
      log: this.log,
    });
  }

  private async resolveUserLinkedAccessToken(input: {
    appUserId?: string;
    companyId: string;
    larkTenantKey?: string;
  }): Promise<string> {
    if (!input.appUserId) {
      throw new LarkRuntimeClientError(
        'Desktop Lark account is not linked to an app user. Sign in with Lark again.',
        'lark_runtime_unavailable',
      );
    }

    const link = await larkUserAuthLinkRepository.findActiveByUser(input.appUserId, input.companyId);
    this.log.info('lark.runtime.user_linked.lookup', {
      companyId: input.companyId,
      appUserId: input.appUserId,
      hasLarkTenantKey: Boolean(input.larkTenantKey),
      foundLink: Boolean(link),
    });
    if (!link) {
      throw new LarkRuntimeClientError(
        'No linked Lark desktop account was found. Sign in with Lark again.',
        'lark_runtime_unavailable',
      );
    }

    if (input.larkTenantKey && link.larkTenantKey !== input.larkTenantKey) {
      throw new LarkRuntimeClientError(
        'Linked Lark account does not belong to the active workspace tenant.',
        'lark_runtime_unavailable',
      );
    }

    if (!link.accessTokenExpiresAt || link.accessTokenExpiresAt.getTime() > Date.now()) {
      this.log.info('lark.runtime.user_linked.token_reused', {
        companyId: input.companyId,
        appUserId: input.appUserId,
        linkId: link.id,
        expiresAt: link.accessTokenExpiresAt?.toISOString() ?? null,
      });
      await larkUserAuthLinkRepository.touchLastUsed(link.id);
      return link.accessToken;
    }

    if (!link.refreshToken || (link.refreshTokenExpiresAt && link.refreshTokenExpiresAt.getTime() <= Date.now())) {
      throw new LarkRuntimeClientError(
        'Linked Lark desktop session has expired. Sign in with Lark again.',
        'lark_runtime_unavailable',
      );
    }

    try {
      this.log.info('lark.runtime.user_linked.refresh.start', {
        companyId: input.companyId,
        appUserId: input.appUserId,
        linkId: link.id,
        accessTokenExpiredAt: link.accessTokenExpiresAt?.toISOString() ?? null,
        refreshTokenExpiresAt: link.refreshTokenExpiresAt?.toISOString() ?? null,
      });
      const refreshed = await larkOAuthService.refreshAccessToken(link.refreshToken);
      const updated = await larkUserAuthLinkRepository.upsert({
        userId: link.userId,
        companyId: link.companyId,
        larkTenantKey: link.larkTenantKey,
        larkOpenId: link.larkOpenId,
        larkUserId: link.larkUserId,
        larkEmail: link.larkEmail,
        larkName: link.larkName,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? link.refreshToken,
        tokenType: refreshed.tokenType ?? link.tokenType,
        accessTokenExpiresAt: refreshed.expiresIn ? new Date(Date.now() + refreshed.expiresIn * 1000) : undefined,
        refreshTokenExpiresAt: refreshed.refreshExpiresIn ? new Date(Date.now() + refreshed.refreshExpiresIn * 1000) : link.refreshTokenExpiresAt,
        tokenMetadata: link.tokenMetadata,
      });
      this.log.info('lark.runtime.user_linked.refresh.success', {
        companyId: input.companyId,
        appUserId: input.appUserId,
        linkId: updated.id,
        accessTokenExpiresAt: updated.accessTokenExpiresAt?.toISOString() ?? null,
        refreshTokenExpiresAt: updated.refreshTokenExpiresAt?.toISOString() ?? null,
      });
      await larkUserAuthLinkRepository.touchLastUsed(updated.id);
      return updated.accessToken;
    } catch (error) {
      this.log.error('lark.runtime.user_linked.refresh.failed', {
        companyId: input.companyId,
        appUserId: input.appUserId,
        linkId: link.id,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      throw new LarkRuntimeClientError(
        `Linked Lark desktop session could not be refreshed: ${error instanceof Error ? error.message : 'unknown_error'}`,
        'lark_runtime_unavailable',
      );
    }
  }
}

export const larkRuntimeClient = new LarkRuntimeClient();
