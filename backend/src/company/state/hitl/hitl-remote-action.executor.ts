import { Buffer } from 'buffer';

import { companyGoogleAuthLinkRepository } from '../../channels/google/company-google-auth-link.repository';
import { googleOAuthService } from '../../channels/google/google-oauth.service';
import { googleUserAuthLinkRepository } from '../../channels/google/google-user-auth-link.repository';
import { zohoBooksClient, type ZohoBooksModule } from '../../integrations/zoho/zoho-books.client';
import { zohoDataClient, type ZohoSourceType } from '../../integrations/zoho/zoho-data.client';
import { logger } from '../../../utils/logger';
import type { HydratedStoredHitlAction } from './hitl-action.repository';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : [];

const buildExpiryFromSeconds = (seconds?: number): Date | undefined => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return new Date(Date.now() + seconds * 1000);
};

const normalizeScopes = (scopes?: string[]): Set<string> =>
  new Set((scopes ?? []).map((scope) => scope.trim()).filter(Boolean));

type StoredRuntimeMetadata = {
  companyId: string;
  userId: string;
  requesterEmail?: string;
};

type ActionExecutionResult = {
  ok: boolean;
  summary: string;
  payload?: Record<string, unknown>;
};

type ResolvedGoogleAccess = {
  accessToken: string;
  mode: 'company' | 'user';
  companyId: string;
  userId: string;
  link: {
    googleUserId?: string;
    googleEmail?: string;
    googleName?: string;
    scope?: string;
    scopes: string[];
    refreshToken?: string;
    refreshTokenExpiresAt?: Date | null;
    accessTokenExpiresAt?: Date | null;
    tokenType?: string;
    tokenMetadata?: Record<string, unknown> | null;
  };
};

const loadRuntimeMetadata = (action: HydratedStoredHitlAction): StoredRuntimeMetadata => {
  const metadata = action.metadata ?? {};
  const companyId = asString(metadata.companyId);
  const userId = asString(metadata.userId);
  if (!companyId || !userId) {
    throw new Error('Stored HITL action is missing company or user context');
  }
  return {
    companyId,
    userId,
    requesterEmail: asString(metadata.requesterEmail),
  };
};

const resolveGoogleAccess = async (
  action: HydratedStoredHitlAction,
  requiredScopes: string[],
): Promise<ResolvedGoogleAccess> => {
  const metadata = loadRuntimeMetadata(action);
  const companyLink = await companyGoogleAuthLinkRepository.findActiveByCompany(metadata.companyId);
  const userLink = companyLink ? null : await googleUserAuthLinkRepository.findActiveByUser(metadata.userId, metadata.companyId);
  const link = companyLink
    ? {
      mode: 'company' as const,
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
        mode: 'user' as const,
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
    throw new Error('No Google account is connected for this company or user');
  }

  const scopeSet = normalizeScopes(link.scopes);
  const missingScopes = requiredScopes.filter((scope) => !scopeSet.has(scope));
  if (missingScopes.length > 0) {
    throw new Error(`Google connection is missing required scopes: ${missingScopes.join(', ')}`);
  }

  let accessToken = link.accessToken;
  const expiresAt = link.accessTokenExpiresAt?.getTime();
  if (expiresAt && expiresAt - Date.now() < 60_000) {
    if (!link.refreshToken) {
      throw new Error('Google access token expired and no refresh token is available');
    }
    const refreshed = await googleOAuthService.refreshAccessToken(link.refreshToken);
    accessToken = refreshed.accessToken;
    if (link.mode === 'company') {
      await companyGoogleAuthLinkRepository.upsert({
        companyId: metadata.companyId,
        googleUserId: link.googleUserId,
        googleEmail: link.googleEmail,
        googleName: link.googleName,
        scope: refreshed.scope ?? link.scope,
        accessToken: refreshed.accessToken,
        refreshToken: link.refreshToken,
        tokenType: refreshed.tokenType ?? link.tokenType,
        accessTokenExpiresAt: buildExpiryFromSeconds(refreshed.expiresIn),
        refreshTokenExpiresAt: link.refreshTokenExpiresAt ?? undefined,
        tokenMetadata: link.tokenMetadata ?? undefined,
        linkedByUserId: metadata.userId,
      });
    } else {
      await googleUserAuthLinkRepository.upsert({
        userId: metadata.userId,
        companyId: metadata.companyId,
        googleUserId: link.googleUserId,
        googleEmail: link.googleEmail,
        googleName: link.googleName,
        scope: refreshed.scope ?? link.scope,
        accessToken: refreshed.accessToken,
        refreshToken: link.refreshToken,
        tokenType: refreshed.tokenType ?? link.tokenType,
        accessTokenExpiresAt: buildExpiryFromSeconds(refreshed.expiresIn),
        refreshTokenExpiresAt: link.refreshTokenExpiresAt ?? undefined,
        tokenMetadata: link.tokenMetadata ?? undefined,
      });
    }
  }

  return {
    accessToken,
    mode: link.mode,
    companyId: metadata.companyId,
    userId: metadata.userId,
    link,
  };
};

const buildMimeMessage = (input: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  isHtml?: boolean;
}): string => {
  const lines = [
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    ...(input.bcc ? [`Bcc: ${input.bcc}`] : []),
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: ${input.isHtml ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
    '',
    input.body,
  ];
  return Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
};

const executeGoogleMailAction = async (action: HydratedStoredHitlAction): Promise<ActionExecutionResult> => {
  const payload = action.payload ?? {};
  const operation = asString(payload.operation);
  if (!operation) {
    throw new Error('Stored Gmail action is missing operation');
  }

  if (operation === 'createDraft') {
    const access = await resolveGoogleAccess(action, ['https://www.googleapis.com/auth/gmail.compose']);
    const raw = buildMimeMessage({
      to: asString(payload.to) ?? '',
      subject: asString(payload.subject) ?? '',
      body: asString(payload.body) ?? '',
      cc: asString(payload.cc),
      bcc: asString(payload.bcc),
      isHtml: Boolean(payload.isHtml),
    });
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          raw,
          ...(asString(payload.threadId) ? { threadId: asString(payload.threadId) } : {}),
        },
      }),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`Gmail draft create failed: ${asString(asRecord(result.error)?.message) ?? response.statusText}`);
    }
    return {
      ok: true,
      summary: `Created Gmail draft "${asString(payload.subject) ?? 'draft'}".`,
      payload: result,
    };
  }

  if (operation === 'sendDraft') {
    const access = await resolveGoogleAccess(action, ['https://www.googleapis.com/auth/gmail.send']);
    const draftId = asString(payload.draftId);
    if (!draftId) {
      throw new Error('Stored Gmail draft-send action is missing draftId');
    }
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: draftId }),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`Gmail draft send failed: ${asString(asRecord(result.error)?.message) ?? response.statusText}`);
    }
    return {
      ok: true,
      summary: `Sent Gmail draft ${draftId}.`,
      payload: result,
    };
  }

  if (operation === 'sendMessage') {
    const access = await resolveGoogleAccess(action, ['https://www.googleapis.com/auth/gmail.send']);
    const raw = buildMimeMessage({
      to: asString(payload.to) ?? '',
      subject: asString(payload.subject) ?? '',
      body: asString(payload.body) ?? '',
      cc: asString(payload.cc),
      bcc: asString(payload.bcc),
      isHtml: Boolean(payload.isHtml),
    });
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        raw,
        ...(asString(payload.threadId) ? { threadId: asString(payload.threadId) } : {}),
      }),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`Gmail send failed: ${asString(asRecord(result.error)?.message) ?? response.statusText}`);
    }
    return {
      ok: true,
      summary: `Sent Gmail message "${asString(payload.subject) ?? 'message'}".`,
      payload: result,
    };
  }

  throw new Error(`Unsupported Gmail approval operation: ${operation}`);
};

const executeGoogleDriveAction = async (action: HydratedStoredHitlAction): Promise<ActionExecutionResult> => {
  const payload = action.payload ?? {};
  const operation = asString(payload.operation);
  if (!operation) {
    throw new Error('Stored Drive action is missing operation');
  }

  if (operation === 'createFolder') {
    const access = await resolveGoogleAccess(action, ['https://www.googleapis.com/auth/drive.file']);
    const response = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: asString(payload.fileName),
        mimeType: 'application/vnd.google-apps.folder',
        ...(asString(payload.parentId) ? { parents: [asString(payload.parentId)] } : {}),
      }),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`Drive folder create failed: ${asString(asRecord(result.error)?.message) ?? response.statusText}`);
    }
    return {
      ok: true,
      summary: `Created Drive folder "${asString(payload.fileName) ?? 'folder'}".`,
      payload: result,
    };
  }

  if (operation === 'uploadFile' || operation === 'updateFile') {
    const access = await resolveGoogleAccess(action, ['https://www.googleapis.com/auth/drive.file']);
    const fileName = asString(payload.fileName);
    const contentBase64 = asString(payload.contentBase64)
      ?? (asString(payload.contentText) ? Buffer.from(asString(payload.contentText) ?? '', 'utf8').toString('base64') : undefined);
    if (!contentBase64) {
      throw new Error(`Stored Drive ${operation} action is missing file content`);
    }
    const mimeType = asString(payload.mimeType) ?? 'application/octet-stream';
    const boundary = `====divo-drive-${Date.now()}====`;
    const metadata = {
      ...(fileName ? { name: fileName } : {}),
      mimeType,
      ...(asString(payload.parentId) ? { parents: [asString(payload.parentId)] } : {}),
    };
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${mimeType}`,
      'Content-Transfer-Encoding: base64',
      '',
      contentBase64,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const fileId = asString(payload.fileId);
    const url = operation === 'updateFile' && fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    const method = operation === 'updateFile' ? 'PATCH' : 'POST';
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`Drive ${operation} failed: ${asString(asRecord(result.error)?.message) ?? response.statusText}`);
    }
    return {
      ok: true,
      summary: operation === 'updateFile'
        ? `Updated Drive file ${fileId ?? ''}.`
        : `Uploaded Drive file "${fileName ?? 'file'}".`,
      payload: result,
    };
  }

  if (operation === 'deleteFile') {
    const access = await resolveGoogleAccess(action, ['https://www.googleapis.com/auth/drive.file']);
    const fileId = asString(payload.fileId);
    if (!fileId) {
      throw new Error('Stored Drive delete action is missing fileId');
    }
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${access.accessToken}` },
    });
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(`Drive delete failed: ${asString(asRecord(result.error)?.message) ?? response.statusText}`);
    }
    return {
      ok: true,
      summary: `Deleted Drive file ${fileId}.`,
      payload: { fileId },
    };
  }

  throw new Error(`Unsupported Drive approval operation: ${operation}`);
};

const executeGoogleCalendarAction = async (action: HydratedStoredHitlAction): Promise<ActionExecutionResult> => {
  const payload = action.payload ?? {};
  const operation = asString(payload.operation);
  if (!operation) {
    throw new Error('Stored Google Calendar action is missing operation');
  }

  const access = await resolveGoogleAccess(action, ['https://www.googleapis.com/auth/calendar.events']);
  const calendarId = encodeURIComponent(asString(payload.calendarId) ?? 'primary');

  if (operation === 'createEvent') {
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload.body ?? {}),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`Google Calendar create failed: ${asString(asRecord(result.error)?.message) ?? response.statusText}`);
    }
    return {
      ok: true,
      summary: `Created Google Calendar event "${asString(result.summary) ?? asString(asRecord(payload.body)?.summary) ?? 'event'}".`,
      payload: result,
    };
  }

  if (operation === 'updateEvent') {
    const eventId = asString(payload.eventId);
    if (!eventId) {
      throw new Error('Stored Google Calendar update action is missing eventId');
    }
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload.body ?? {}),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`Google Calendar update failed: ${asString(asRecord(result.error)?.message) ?? response.statusText}`);
    }
    return {
      ok: true,
      summary: `Updated Google Calendar event "${asString(result.summary) ?? eventId}".`,
      payload: result,
    };
  }

  if (operation === 'deleteEvent') {
    const eventId = asString(payload.eventId);
    if (!eventId) {
      throw new Error('Stored Google Calendar delete action is missing eventId');
    }
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${access.accessToken}` },
    });
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(`Google Calendar delete failed: ${asString(asRecord(result.error)?.message) ?? response.statusText}`);
    }
    return {
      ok: true,
      summary: `Deleted Google Calendar event ${eventId}.`,
      payload: { eventId },
    };
  }

  throw new Error(`Unsupported Google Calendar approval operation: ${operation}`);
};

const moduleNameToSourceType = (moduleName: string): ZohoSourceType => {
  const normalized = moduleName.trim().toLowerCase();
  if (normalized === 'leads' || normalized === 'lead') return 'zoho_lead';
  if (normalized === 'contacts' || normalized === 'contact') return 'zoho_contact';
  if (normalized === 'deals' || normalized === 'deal') return 'zoho_deal';
  if (normalized === 'cases' || normalized === 'case' || normalized === 'tickets' || normalized === 'ticket') return 'zoho_ticket';
  throw new Error(`Unsupported Zoho module for mutation: ${moduleName}`);
};

const moduleNameToBooksModule = (moduleName: string): ZohoBooksModule => {
  const normalized = moduleName.trim().toLowerCase();
  if (normalized === 'invoice' || normalized === 'invoices') return 'invoices';
  if (normalized === 'estimate' || normalized === 'estimates') return 'estimates';
  if (normalized === 'bill' || normalized === 'bills') return 'bills';
  if (normalized === 'payment' || normalized === 'payments' || normalized === 'customerpayment' || normalized === 'customerpayments') {
    return 'customerpayments';
  }
  if (normalized === 'banktransaction' || normalized === 'banktransactions') return 'banktransactions';
  throw new Error(`Unsupported Zoho Books module for mutation: ${moduleName}`);
};

const executeZohoAction = async (action: HydratedStoredHitlAction): Promise<ActionExecutionResult> => {
  const payload = action.payload ?? {};
  const operation = asString(payload.operation);
  const moduleName = asString(payload.module);
  if (!operation || !moduleName) {
    throw new Error('Stored Zoho action is missing operation or module');
  }
  const sourceType = moduleNameToSourceType(moduleName);
  const metadata = loadRuntimeMetadata(action);

  if (operation === 'createRecord') {
    const result = await zohoDataClient.createRecord({
      companyId: metadata.companyId,
      sourceType,
      fields: asRecord(payload.fields) ?? {},
      trigger: asStringArray(payload.trigger),
    });
    return {
      ok: true,
      summary: `Created Zoho ${moduleName} record.`,
      payload: result,
    };
  }

  if (operation === 'updateRecord') {
    const recordId = asString(payload.recordId);
    if (!recordId) {
      throw new Error('Stored Zoho update action is missing recordId');
    }
    const result = await zohoDataClient.updateRecord({
      companyId: metadata.companyId,
      sourceType,
      sourceId: recordId,
      fields: asRecord(payload.fields) ?? {},
      trigger: asStringArray(payload.trigger),
    });
    return {
      ok: true,
      summary: `Updated Zoho ${moduleName} record ${recordId}.`,
      payload: result,
    };
  }

  if (operation === 'deleteRecord') {
    const recordId = asString(payload.recordId);
    if (!recordId) {
      throw new Error('Stored Zoho delete action is missing recordId');
    }
    await zohoDataClient.deleteRecord({
      companyId: metadata.companyId,
      sourceType,
      sourceId: recordId,
    });
    return {
      ok: true,
      summary: `Deleted Zoho ${moduleName} record ${recordId}.`,
      payload: { recordId },
    };
  }

  throw new Error(`Unsupported Zoho approval operation: ${operation}`);
};

const executeZohoBooksAction = async (action: HydratedStoredHitlAction): Promise<ActionExecutionResult> => {
  const payload = action.payload ?? {};
  const operation = asString(payload.operation);
  const moduleName = asString(payload.module);
  if (!operation || !moduleName) {
    throw new Error('Stored Zoho Books action is missing operation or module');
  }
  const booksModule = moduleNameToBooksModule(moduleName);
  const metadata = loadRuntimeMetadata(action);
  const organizationId = asString(payload.organizationId);

  if (operation === 'createRecord') {
    const result = await zohoBooksClient.createRecord({
      companyId: metadata.companyId,
      moduleName: booksModule,
      organizationId,
      body: asRecord(payload.body) ?? {},
    });
    return {
      ok: true,
      summary: `Created Zoho Books ${moduleName} record.`,
      payload: result.payload,
    };
  }

  if (operation === 'updateRecord') {
    const recordId = asString(payload.recordId);
    if (!recordId) {
      throw new Error('Stored Zoho Books update action is missing recordId');
    }
    const result = await zohoBooksClient.updateRecord({
      companyId: metadata.companyId,
      moduleName: booksModule,
      recordId,
      organizationId,
      body: asRecord(payload.body) ?? {},
    });
    return {
      ok: true,
      summary: `Updated Zoho Books ${moduleName} record ${recordId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'deleteRecord') {
    const recordId = asString(payload.recordId);
    if (!recordId) {
      throw new Error('Stored Zoho Books delete action is missing recordId');
    }
    const result = await zohoBooksClient.deleteRecord({
      companyId: metadata.companyId,
      moduleName: booksModule,
      recordId,
      organizationId,
    });
    return {
      ok: true,
      summary: `Deleted Zoho Books ${moduleName} record ${recordId}.`,
      payload: result.payload,
    };
  }

  throw new Error(`Unsupported Zoho Books approval operation: ${operation}`);
};

export const executeStoredRemoteToolAction = async (action: HydratedStoredHitlAction): Promise<ActionExecutionResult> => {
  const toolId = asString(action.toolId) ?? asString(action.payload?.toolId);
  if (!toolId) {
    throw new Error('Stored HITL action is missing toolId');
  }

  logger.info('hitl.remote_action.execute.start', {
    actionId: action.actionId,
    toolId,
    actionGroup: action.actionGroup,
    channel: action.channel,
  });

  switch (toolId) {
    case 'google-gmail':
      return executeGoogleMailAction(action);
    case 'google-drive':
      return executeGoogleDriveAction(action);
    case 'google-calendar':
      return executeGoogleCalendarAction(action);
    case 'zoho-write':
      return executeZohoAction(action);
    case 'zoho-books-write':
      return executeZohoBooksAction(action);
    default:
      throw new Error(`Unsupported remote HITL tool execution: ${toolId}`);
  }
};
