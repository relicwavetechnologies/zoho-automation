import { companyGoogleAuthLinkRepository } from '../../../../channels/google/company-google-auth-link.repository';
import { googleOAuthService } from '../../../../channels/google/google-oauth.service';
import { googleUserAuthLinkRepository } from '../../../../channels/google/google-user-auth-link.repository';
import { withProviderRetry } from '../../../../../utils/provider-retry';
import type { VercelRuntimeRequestContext, VercelToolEnvelope } from '../../types';

const buildExpiryFromSeconds = (seconds?: number): Date | undefined => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return new Date(Date.now() + seconds * 1000);
};

const normalizeGoogleScopes = (scopes?: string[]): Set<string> =>
  new Set((scopes ?? []).map((scope) => scope.trim()).filter(Boolean));

type ResolvedGoogleLink = {
  mode: 'company' | 'user';
  accessToken: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: Date | null;
  accessTokenExpiresAt?: Date | null;
  tokenType?: string;
  scope?: string;
  scopes: string[];
  googleUserId: string;
  googleEmail?: string;
  googleName?: string;
  tokenMetadata?: Record<string, unknown> | null;
};

export const resolveGoogleAccess = async (
  runtime: VercelRuntimeRequestContext,
  requiredScopes: string[],
  deps: {
    buildEnvelope: (payload: Record<string, unknown>) => VercelToolEnvelope;
  },
): Promise<{ accessToken: string; scopes: string[] } | { error: VercelToolEnvelope }> => {
  const companyLink = await companyGoogleAuthLinkRepository.findActiveByCompany(runtime.companyId);
  const userLink = companyLink
    ? null
    : await googleUserAuthLinkRepository.findActiveByUser(runtime.userId, runtime.companyId);
  const link: ResolvedGoogleLink | null = companyLink
    ? {
        mode: 'company',
        accessToken: companyLink.accessToken,
        refreshToken: companyLink.refreshToken,
        refreshTokenExpiresAt: companyLink.refreshTokenExpiresAt,
        accessTokenExpiresAt: companyLink.accessTokenExpiresAt,
        tokenType: companyLink.tokenType,
        scope: companyLink.scope,
        scopes: companyLink.scopes,
        googleUserId: companyLink.googleUserId,
        googleEmail: companyLink.googleEmail,
        googleName: companyLink.googleName,
        tokenMetadata: companyLink.tokenMetadata,
      }
    : userLink
      ? {
          mode: 'user',
          accessToken: userLink.accessToken,
          refreshToken: userLink.refreshToken,
          refreshTokenExpiresAt: userLink.refreshTokenExpiresAt,
          accessTokenExpiresAt: userLink.accessTokenExpiresAt,
          tokenType: userLink.tokenType,
          scope: userLink.scope,
          scopes: userLink.scopes,
          googleUserId: userLink.googleUserId,
          googleEmail: userLink.googleEmail,
          googleName: userLink.googleName,
          tokenMetadata: userLink.tokenMetadata,
        }
      : null;
  if (!link) {
    return {
      error: deps.buildEnvelope({
        success: false,
        summary: 'No Google account is connected for this workspace or user.',
        errorKind: 'permission',
        retryable: false,
        userAction:
          'Connect Google Workspace from Admin Settings → Integrations, or connect a personal Google account in desktop settings.',
      }),
    };
  }

  const scopeSet = normalizeGoogleScopes(link.scopes);
  const missingScopes = requiredScopes.filter((scope) => !scopeSet.has(scope));
  if (missingScopes.length > 0) {
    return {
      error: deps.buildEnvelope({
        success: false,
        summary: 'Google connection is missing required scopes.',
        errorKind: 'permission',
        retryable: false,
        userAction: `Reconnect Google and grant: ${missingScopes.join(', ')}`,
      }),
    };
  }

  let accessToken = link.accessToken;
  const expiresAt = link.accessTokenExpiresAt?.getTime();
  if (expiresAt && expiresAt - Date.now() < 60_000) {
    if (!link.refreshToken) {
      return {
        error: deps.buildEnvelope({
          success: false,
          summary: 'Google access token expired and no refresh token is available.',
          errorKind: 'permission',
          retryable: false,
          userAction: 'Reconnect your Google account to refresh credentials.',
        }),
      };
    }
    const refreshed = await googleOAuthService.refreshAccessToken(link.refreshToken);
    accessToken = refreshed.accessToken;
    if (link.mode === 'company') {
      await companyGoogleAuthLinkRepository.upsert({
        companyId: runtime.companyId,
        googleUserId: link.googleUserId,
        googleEmail: link.googleEmail,
        googleName: link.googleName,
        scope: refreshed.scope ?? link.scope,
        accessToken: refreshed.accessToken,
        refreshToken: link.refreshToken,
        tokenType: refreshed.tokenType ?? link.tokenType,
        accessTokenExpiresAt: buildExpiryFromSeconds(refreshed.expiresIn),
        refreshTokenExpiresAt: link.refreshTokenExpiresAt,
        tokenMetadata: link.tokenMetadata ?? undefined,
        linkedByUserId: runtime.userId,
      });
    } else {
      await googleUserAuthLinkRepository.upsert({
        userId: runtime.userId,
        companyId: runtime.companyId,
        googleUserId: link.googleUserId,
        googleEmail: link.googleEmail,
        googleName: link.googleName,
        scope: refreshed.scope ?? link.scope,
        accessToken: refreshed.accessToken,
        refreshToken: link.refreshToken,
        tokenType: refreshed.tokenType ?? link.tokenType,
        accessTokenExpiresAt: buildExpiryFromSeconds(refreshed.expiresIn),
        refreshTokenExpiresAt: link.refreshTokenExpiresAt,
        tokenMetadata: link.tokenMetadata ?? undefined,
      });
    }
  }

  return { accessToken, scopes: link.scopes };
};

export const fetchGoogleApiResponseWithRetry = async (
  accessToken: string,
  url: string | URL,
  init?: RequestInit,
): Promise<Response> =>
  withProviderRetry('google', async () => {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const payload = await response.clone().json().catch(() => ({}));
      const error: Error & {
        status?: number;
        headers?: Record<string, string>;
        payload?: unknown;
      } = new Error(`google_api_${response.status}`);
      error.status = response.status;
      error.headers = Object.fromEntries(response.headers.entries());
      error.payload = payload;
      throw error;
    }

    return response;
  });

export const fetchGoogleApiJsonWithRetry = async <T = Record<string, unknown>>(
  accessToken: string,
  url: string | URL,
  init?: RequestInit,
): Promise<{ response: Response; payload: T }> => {
  const response = await fetchGoogleApiResponseWithRetry(accessToken, url, init);
  const payload = (await response.json().catch(() => ({}))) as T;
  return { response, payload };
};

const decodeGmailBodyData = (value: string | null | undefined): string | null => {
  const encoded = value?.trim();
  if (!encoded) return null;
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, 'base64').toString('utf-8');
  } catch {
    return null;
  }
};

const getGmailHeaderValue = (
  headers: Array<Record<string, unknown>>,
  headerName: string,
  asString: (value: unknown) => string | undefined,
): string | null => {
  const normalized = headerName.trim().toLowerCase();
  for (const header of headers) {
    const name = asString(header.name)?.trim().toLowerCase();
    if (name === normalized) {
      return asString(header.value) ?? null;
    }
  }
  return null;
};

const extractPlainTextBody = (
  payload: Record<string, unknown> | undefined,
  deps: {
    asRecord: (value: unknown) => Record<string, unknown> | null;
    asArray: <T = unknown>(value: unknown) => T[];
    asString: (value: unknown) => string | undefined;
  },
): string | null => {
  if (!payload) return null;
  const mimeType = deps.asString(payload.mimeType)?.trim().toLowerCase();
  const body = deps.asRecord(payload.body);
  const decoded = decodeGmailBodyData(deps.asString(body?.data));
  if (mimeType === 'text/plain' && decoded?.trim()) {
    return decoded.trim().slice(0, 500);
  }
  const parts = deps.asArray(payload.parts)
    .map((entry) => deps.asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  for (const part of parts) {
    const text = extractPlainTextBody(part, deps);
    if (text) return text;
  }
  if (mimeType === 'text/html' && decoded?.trim()) {
    return decoded
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500) || null;
  }
  return null;
};

export const normalizeGmailMessage = (
  rawMessage: Record<string, unknown>,
  deps: {
    asRecord: (value: unknown) => Record<string, unknown> | null;
    asArray: <T = unknown>(value: unknown) => T[];
    asString: (value: unknown) => string | undefined;
  },
): Record<string, unknown> => {
  const payload = deps.asRecord(rawMessage.payload);
  const headers = deps.asArray(payload?.headers)
    .map((entry) => deps.asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const from = getGmailHeaderValue(headers, 'from', deps.asString);
  const to = getGmailHeaderValue(headers, 'to', deps.asString);
  const subject = getGmailHeaderValue(headers, 'subject', deps.asString);
  const date = getGmailHeaderValue(headers, 'date', deps.asString);
  const inReplyTo = getGmailHeaderValue(headers, 'in-reply-to', deps.asString);
  const references = getGmailHeaderValue(headers, 'references', deps.asString);

  return {
    messageId: deps.asString(rawMessage.id),
    threadId: deps.asString(rawMessage.threadId),
    from,
    to,
    subject,
    date,
    snippet: deps.asString(rawMessage.snippet) ?? null,
    bodyText: extractPlainTextBody(payload ?? undefined, deps),
    replyFound: Boolean(inReplyTo || references),
    labelIds: deps.asArray(rawMessage.labelIds)
      .map((entry) => deps.asString(entry))
      .filter((entry): entry is string => Boolean(entry)),
  };
};
