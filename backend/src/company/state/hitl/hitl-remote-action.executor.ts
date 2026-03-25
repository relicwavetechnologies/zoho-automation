import { Buffer } from 'buffer';

import { companyGoogleAuthLinkRepository } from '../../channels/google/company-google-auth-link.repository';
import { googleOAuthService } from '../../channels/google/google-oauth.service';
import { googleUserAuthLinkRepository } from '../../channels/google/google-user-auth-link.repository';
import { departmentService } from '../../departments/department.service';
import { formatZohoGatewayDeniedMessage } from '../../integrations/zoho/zoho-gateway-denials';
import { zohoGatewayService } from '../../integrations/zoho/zoho-gateway.service';
import { zohoBooksClient, type ZohoBooksModule } from '../../integrations/zoho/zoho-books.client';
import { zohoDataClient, type ZohoSourceType } from '../../integrations/zoho/zoho-data.client';
import { isSupportedToolActionGroup, type ToolActionGroup } from '../../tools/tool-action-groups';
import { toolPermissionService } from '../../tools/tool-permission.service';
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
  requesterAiRole?: string;
  departmentId?: string;
  departmentName?: string;
  departmentRoleSlug?: string;
};

type ActionExecutionResult = {
  ok: boolean;
  summary: string;
  payload?: Record<string, unknown>;
};

const readBooksRecordId = (record: Record<string, unknown>, moduleName: ZohoBooksModule): string | undefined => {
  if (moduleName === 'invoices') {
    return asString(record.invoice_id) ?? asString(record.id);
  }
  if (moduleName === 'estimates') {
    return asString(record.estimate_id) ?? asString(record.id);
  }
  if (moduleName === 'bills') {
    return asString(record.bill_id) ?? asString(record.id);
  }
  return asString(record.id);
};

const readBooksRecordNumber = (record: Record<string, unknown>, moduleName: ZohoBooksModule): string | undefined => {
  if (moduleName === 'invoices') {
    return asString(record.invoice_number) ?? asString(record.invoiceNumber);
  }
  if (moduleName === 'estimates') {
    return asString(record.estimate_number) ?? asString(record.estimateNumber);
  }
  if (moduleName === 'bills') {
    return asString(record.bill_number) ?? asString(record.billNumber);
  }
  return undefined;
};

const resolveZohoBooksRecordIdentifier = async (input: {
  companyId: string;
  organizationId?: string;
  moduleName: ZohoBooksModule;
  identifier: string;
  requesterEmail?: string;
  requesterAiRole?: string;
}): Promise<{ recordId: string; matchedBy: 'id' | 'number' }> => {
  const direct = input.identifier.trim();
  const auth = await zohoGatewayService.listAuthorizedRecords({
    domain: 'books',
    module: input.moduleName,
    requester: {
      companyId: input.companyId,
      requesterEmail: input.requesterEmail,
      requesterAiRole: input.requesterAiRole,
    },
    organizationId: input.organizationId,
    query: direct,
    limit: 20,
  });
  if (!auth.allowed) {
    throw new Error(formatZohoGatewayDeniedMessage(auth, `You are not allowed to read Zoho Books ${input.moduleName}.`).summary);
  }
  const records = Array.isArray(auth.payload?.records) ? auth.payload.records : [];

  const exactIdMatch = records.find((record) => readBooksRecordId(record, input.moduleName) === direct);
  if (exactIdMatch) {
    return {
      recordId: readBooksRecordId(exactIdMatch, input.moduleName)!,
      matchedBy: 'id',
    };
  }

  const exactNumberMatch = records.find((record) => readBooksRecordNumber(record, input.moduleName) === direct);
  if (exactNumberMatch) {
    return {
      recordId: readBooksRecordId(exactNumberMatch, input.moduleName)!,
      matchedBy: 'number',
    };
  }

  return {
    recordId: direct,
    matchedBy: 'id',
  };
};

const buildZohoGatewayRequester = (metadata: StoredRuntimeMetadata) => ({
  companyId: metadata.companyId,
  requesterEmail: metadata.requesterEmail,
  requesterAiRole: metadata.requesterAiRole,
});

const buildBooksMutationAuthorizationTarget = (input: {
  operation: string;
  moduleName?: string;
  recordId?: string;
  accountId?: string;
  transactionId?: string;
  invoiceId?: string;
  estimateId?: string;
  creditNoteId?: string;
  salesOrderId?: string;
  purchaseOrderId?: string;
  billId?: string;
  contactId?: string;
  vendorPaymentId?: string;
  organizationId?: string;
}) => {
  let module = input.moduleName;
  let recordId = input.recordId;

  if (['activateBankAccount', 'deactivateBankAccount', 'importBankStatement'].includes(input.operation)) {
    module = 'bankaccounts';
    recordId = input.accountId;
  } else if ([
    'matchBankTransaction',
    'unmatchBankTransaction',
    'excludeBankTransaction',
    'restoreBankTransaction',
    'uncategorizeBankTransaction',
    'categorizeBankTransaction',
    'categorizeBankTransactionAsExpense',
    'categorizeBankTransactionAsVendorPayment',
    'categorizeBankTransactionAsCustomerPayment',
    'categorizeBankTransactionAsCreditNoteRefund',
  ].includes(input.operation)) {
    module = 'banktransactions';
    recordId = input.transactionId;
  } else if ([
    'emailInvoice',
    'remindInvoice',
    'enableInvoicePaymentReminder',
    'disableInvoicePaymentReminder',
    'writeOffInvoice',
    'cancelInvoiceWriteOff',
    'markInvoiceSent',
    'voidInvoice',
    'markInvoiceDraft',
    'submitInvoice',
    'approveInvoice',
  ].includes(input.operation)) {
    module = 'invoices';
    recordId = input.invoiceId;
  } else if ([
    'emailEstimate',
    'markEstimateSent',
    'acceptEstimate',
    'declineEstimate',
    'submitEstimate',
    'approveEstimate',
  ].includes(input.operation)) {
    module = 'estimates';
    recordId = input.estimateId;
  } else if (['emailCreditNote', 'openCreditNote', 'voidCreditNote', 'refundCreditNote'].includes(input.operation)) {
    module = 'creditnotes';
    recordId = input.creditNoteId;
  } else if ([
    'emailSalesOrder',
    'openSalesOrder',
    'voidSalesOrder',
    'submitSalesOrder',
    'approveSalesOrder',
    'createInvoiceFromSalesOrder',
  ].includes(input.operation)) {
    module = 'salesorders';
    recordId = input.salesOrderId;
  } else if ([
    'emailPurchaseOrder',
    'openPurchaseOrder',
    'billPurchaseOrder',
    'cancelPurchaseOrder',
    'rejectPurchaseOrder',
    'submitPurchaseOrder',
    'approvePurchaseOrder',
  ].includes(input.operation)) {
    module = 'purchaseorders';
    recordId = input.purchaseOrderId;
  } else if (['voidBill', 'openBill', 'submitBill', 'approveBill'].includes(input.operation)) {
    module = 'bills';
    recordId = input.billId;
  } else if ([
    'emailContact',
    'emailContactStatement',
    'enableContactPaymentReminder',
    'disableContactPaymentReminder',
  ].includes(input.operation)) {
    module = 'contacts';
    recordId = input.contactId;
  } else if (input.operation === 'emailVendorPayment') {
    module = 'vendorpayments';
    recordId = input.vendorPaymentId;
  }

  return {
    domain: 'books' as const,
    module,
    operation: input.operation,
    recordId,
    organizationId: input.organizationId,
  };
};

const authorizeZohoMutationOrThrow = async (input: {
  metadata: StoredRuntimeMetadata;
  domain: 'crm' | 'books';
  operation: string;
  module?: string;
  recordId?: string;
  organizationId?: string;
}) => {
  const auth = await zohoGatewayService.executeAuthorizedMutation({
    domain: input.domain,
    operation: input.operation,
    module: input.module,
    recordId: input.recordId,
    organizationId: input.organizationId,
    requester: buildZohoGatewayRequester(input.metadata),
  });
  if (!auth.allowed) {
    throw new Error(formatZohoGatewayDeniedMessage(auth, `You are not allowed to mutate Zoho ${input.module ?? input.operation}.`).summary);
  }
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
    requesterAiRole: asString(metadata.requesterAiRole),
    departmentId: asString(metadata.departmentId),
    departmentName: asString(metadata.departmentName),
    departmentRoleSlug: asString(metadata.departmentRoleSlug),
  };
};

const enforceCurrentToolPermission = async (
  action: HydratedStoredHitlAction,
  input: {
    toolId: string;
    actionGroup?: ToolActionGroup;
  },
): Promise<void> => {
  const metadata = loadRuntimeMetadata(action);
  const actionGroup = input.actionGroup ?? (asString(action.actionGroup) as ToolActionGroup | undefined);
  const requesterAiRole = metadata.requesterAiRole ?? 'MEMBER';

  if (!actionGroup) {
    throw new Error(`Stored HITL action is missing actionGroup for ${input.toolId}`);
  }
  if (!isSupportedToolActionGroup(input.toolId, actionGroup)) {
    throw new Error(`Tool "${input.toolId}" does not support "${actionGroup}" actions.`);
  }

  const fallbackAllowedToolIds = await toolPermissionService.getAllowedTools(metadata.companyId, requesterAiRole);
  const runtime = await departmentService.resolveRuntimeContext({
    userId: metadata.userId,
    companyId: metadata.companyId,
    departmentId: metadata.departmentId,
    fallbackAllowedToolIds,
  });
  const allowedActionGroups = runtime.allowedActionsByTool?.[input.toolId] ?? [];
  if (!allowedActionGroups.includes(actionGroup)) {
    logger.warn('hitl.remote_action.execute.permission_denied', {
      actionId: action.actionId,
      toolId: input.toolId,
      actionGroup,
      companyId: metadata.companyId,
      userId: metadata.userId,
      requesterAiRole,
      departmentId: runtime.departmentId ?? metadata.departmentId,
      departmentRoleSlug: runtime.departmentRoleSlug ?? metadata.departmentRoleSlug,
      allowedActionGroups,
    });
    throw new Error(
      `Permission denied: ${input.toolId} cannot perform ${actionGroup} for the requester's current role.`,
    );
  }
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
  if (normalized === 'accounts' || normalized === 'account' || normalized === 'companies' || normalized === 'company') return 'zoho_account';
  if (normalized === 'deals' || normalized === 'deal') return 'zoho_deal';
  if (normalized === 'cases' || normalized === 'case' || normalized === 'tickets' || normalized === 'ticket') return 'zoho_ticket';
  throw new Error(`Unsupported Zoho module for mutation: ${moduleName}`);
};

const moduleNameToCrmModule = (moduleName: string): string => {
  const normalized = moduleName.trim().toLowerCase();
  if (normalized === 'leads' || normalized === 'lead') return 'Leads';
  if (normalized === 'contacts' || normalized === 'contact') return 'Contacts';
  if (normalized === 'accounts' || normalized === 'account' || normalized === 'companies' || normalized === 'company') return 'Accounts';
  if (normalized === 'deals' || normalized === 'deal') return 'Deals';
  if (normalized === 'cases' || normalized === 'case' || normalized === 'tickets' || normalized === 'ticket') return 'Cases';
  if (normalized === 'tasks' || normalized === 'task') return 'Tasks';
  if (normalized === 'events' || normalized === 'event' || normalized === 'meetings' || normalized === 'meeting') return 'Events';
  if (normalized === 'calls' || normalized === 'call') return 'Calls';
  if (normalized === 'products' || normalized === 'product') return 'Products';
  if (normalized === 'quotes' || normalized === 'quote') return 'Quotes';
  if (normalized === 'vendors' || normalized === 'vendor') return 'Vendors';
  if (normalized === 'invoices' || normalized === 'invoice') return 'Invoices';
  if (normalized === 'salesorders' || normalized === 'salesorder' || normalized === 'sales_orders' || normalized === 'sales-order') return 'Sales_Orders';
  if (normalized === 'purchaseorders' || normalized === 'purchaseorder' || normalized === 'purchase_orders' || normalized === 'purchase-order') return 'Purchase_Orders';
  return moduleName.trim();
};

const moduleNameToBooksModule = (moduleName: string): ZohoBooksModule => {
  const normalized = moduleName.trim().toLowerCase();
  if (normalized === 'contact' || normalized === 'contacts' || normalized === 'customer' || normalized === 'customers' || normalized === 'vendor' || normalized === 'vendors') {
    return 'contacts';
  }
  if (normalized === 'invoice' || normalized === 'invoices') return 'invoices';
  if (normalized === 'estimate' || normalized === 'estimates') return 'estimates';
  if (normalized === 'creditnote' || normalized === 'creditnotes' || normalized === 'credit-note' || normalized === 'credit-notes') {
    return 'creditnotes';
  }
  if (normalized === 'bill' || normalized === 'bills') return 'bills';
  if (normalized === 'salesorder' || normalized === 'salesorders' || normalized === 'sales-order' || normalized === 'sales-orders') {
    return 'salesorders';
  }
  if (normalized === 'purchaseorder' || normalized === 'purchaseorders' || normalized === 'purchase-order' || normalized === 'purchase-orders') {
    return 'purchaseorders';
  }
  if (normalized === 'payment' || normalized === 'payments' || normalized === 'customerpayment' || normalized === 'customerpayments') {
    return 'customerpayments';
  }
  if (normalized === 'vendorpayment' || normalized === 'vendorpayments') return 'vendorpayments';
  if (normalized === 'bankaccount' || normalized === 'bankaccounts' || normalized === 'account' || normalized === 'accounts') {
    return 'bankaccounts';
  }
  if (normalized === 'banktransaction' || normalized === 'banktransactions') return 'banktransactions';
  throw new Error(`Unsupported Zoho Books module for mutation: ${moduleName}`);
};

const executeZohoAction = async (action: HydratedStoredHitlAction): Promise<ActionExecutionResult> => {
  const payload = action.payload ?? {};
  const operation = asString(payload.operation);
  const moduleName = asString(payload.module);
  if (!operation) {
    throw new Error('Stored Zoho action is missing operation');
  }
  const needsModule =
    operation === 'createRecord'
    || operation === 'updateRecord'
    || operation === 'deleteRecord'
    || operation === 'createNote'
    || operation === 'uploadAttachment'
    || operation === 'deleteAttachment';
  if (needsModule && !moduleName) {
    throw new Error('Stored Zoho action is missing module');
  }
  const sourceType = moduleName ? moduleNameToSourceType(moduleName) : undefined;
  const crmModuleName = moduleName ? moduleNameToCrmModule(moduleName) : undefined;
  const metadata = loadRuntimeMetadata(action);

  if (operation === 'createRecord') {
    await authorizeZohoMutationOrThrow({
      metadata,
      domain: 'crm',
      operation,
      module: crmModuleName,
    });
    const result = sourceType
      ? await zohoDataClient.createRecord({
        companyId: metadata.companyId,
        sourceType,
        fields: asRecord(payload.fields) ?? {},
        trigger: asStringArray(payload.trigger),
      })
      : await zohoDataClient.createModuleRecord({
        companyId: metadata.companyId,
        moduleName: crmModuleName!,
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
    await authorizeZohoMutationOrThrow({
      metadata,
      domain: 'crm',
      operation,
      module: crmModuleName,
      recordId,
    });
    const result = sourceType
      ? await zohoDataClient.updateRecord({
        companyId: metadata.companyId,
        sourceType,
        sourceId: recordId,
        fields: asRecord(payload.fields) ?? {},
        trigger: asStringArray(payload.trigger),
      })
      : await zohoDataClient.updateModuleRecord({
        companyId: metadata.companyId,
        moduleName: crmModuleName!,
        recordId,
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
    await authorizeZohoMutationOrThrow({
      metadata,
      domain: 'crm',
      operation,
      module: crmModuleName,
      recordId,
    });
    if (sourceType) {
      await zohoDataClient.deleteRecord({
        companyId: metadata.companyId,
        sourceType,
        sourceId: recordId,
      });
    } else {
      await zohoDataClient.deleteModuleRecord({
        companyId: metadata.companyId,
        moduleName: crmModuleName!,
        recordId,
      });
    }
    return {
      ok: true,
      summary: `Deleted Zoho ${moduleName} record ${recordId}.`,
      payload: { recordId },
    };
  }

  if (operation === 'createNote') {
    const recordId = asString(payload.recordId);
    if (!recordId) {
      throw new Error('Stored Zoho createNote action is missing recordId');
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      domain: 'crm',
      operation,
      module: crmModuleName,
      recordId,
    });
    const result = sourceType
      ? await zohoDataClient.createNote({
        companyId: metadata.companyId,
        sourceType,
        sourceId: recordId,
        fields: asRecord(payload.fields) ?? {},
      })
      : await zohoDataClient.createModuleNote({
        companyId: metadata.companyId,
        moduleName: crmModuleName!,
        recordId,
        fields: asRecord(payload.fields) ?? {},
      });
    return {
      ok: true,
      summary: `Created Zoho ${moduleName} note on record ${recordId}.`,
      payload: result,
    };
  }

  if (operation === 'updateNote') {
    const noteId = asString(payload.noteId);
    if (!noteId) {
      throw new Error('Stored Zoho updateNote action is missing noteId');
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      domain: 'crm',
      operation,
      module: crmModuleName,
      recordId: asString(payload.recordId),
    });
    const result = await zohoDataClient.updateNote({
      companyId: metadata.companyId,
      noteId,
      fields: asRecord(payload.fields) ?? {},
    });
    return {
      ok: true,
      summary: `Updated Zoho note ${noteId}.`,
      payload: result,
    };
  }

  if (operation === 'deleteNote') {
    const noteId = asString(payload.noteId);
    if (!noteId) {
      throw new Error('Stored Zoho deleteNote action is missing noteId');
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      domain: 'crm',
      operation,
      module: crmModuleName,
      recordId: asString(payload.recordId),
    });
    await zohoDataClient.deleteNote({
      companyId: metadata.companyId,
      noteId,
    });
    return {
      ok: true,
      summary: `Deleted Zoho note ${noteId}.`,
      payload: { noteId },
    };
  }

  if (operation === 'uploadAttachment') {
    const recordId = asString(payload.recordId);
    if (!recordId) {
      throw new Error('Stored Zoho uploadAttachment action is missing recordId');
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      domain: 'crm',
      operation,
      module: crmModuleName,
      recordId,
    });
    const result = sourceType
      ? await zohoDataClient.uploadAttachment({
        companyId: metadata.companyId,
        sourceType,
        sourceId: recordId,
        fileName: asString(payload.fileName),
        contentType: asString(payload.contentType),
        contentBase64: asString(payload.contentBase64),
        attachmentUrl: asString(payload.attachmentUrl),
      })
      : await zohoDataClient.uploadModuleAttachment({
        companyId: metadata.companyId,
        moduleName: crmModuleName!,
        recordId,
        fileName: asString(payload.fileName),
        contentType: asString(payload.contentType),
        contentBase64: asString(payload.contentBase64),
        attachmentUrl: asString(payload.attachmentUrl),
      });
    return {
      ok: true,
      summary: `Uploaded Zoho attachment to ${moduleName} ${recordId}.`,
      payload: result,
    };
  }

  if (operation === 'deleteAttachment') {
    const recordId = asString(payload.recordId);
    const attachmentId = asString(payload.attachmentId);
    if (!recordId || !attachmentId) {
      throw new Error('Stored Zoho deleteAttachment action is missing recordId or attachmentId');
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      domain: 'crm',
      operation,
      module: crmModuleName,
      recordId,
    });
    if (sourceType) {
      await zohoDataClient.deleteAttachment({
        companyId: metadata.companyId,
        sourceType,
        sourceId: recordId,
        attachmentId,
      });
    } else {
      await zohoDataClient.deleteModuleAttachment({
        companyId: metadata.companyId,
        moduleName: crmModuleName!,
        recordId,
        attachmentId,
      });
    }
    return {
      ok: true,
      summary: `Deleted Zoho attachment ${attachmentId} from ${moduleName} ${recordId}.`,
      payload: { recordId, attachmentId },
    };
  }

  throw new Error(`Unsupported Zoho approval operation: ${operation}`);
};

const executeZohoBooksAction = async (action: HydratedStoredHitlAction): Promise<ActionExecutionResult> => {
  const payload = action.payload ?? {};
  const operation = asString(payload.operation);
  const moduleName = asString(payload.module);
  if (!operation) {
    throw new Error('Stored Zoho Books action is missing operation');
  }
  const isRecordCrudOperation = operation === 'createRecord' || operation === 'updateRecord' || operation === 'deleteRecord';
  if (isRecordCrudOperation && !moduleName) {
    throw new Error('Stored Zoho Books record action is missing module');
  }
  const booksModule = moduleName ? moduleNameToBooksModule(moduleName) : undefined;
  const metadata = loadRuntimeMetadata(action);
  const organizationId = asString(payload.organizationId);

  if (operation === 'createRecord') {
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        moduleName: booksModule,
        recordId: asString(payload.recordId),
        organizationId,
      }),
    });
    const result = await zohoBooksClient.createRecord({
      companyId: metadata.companyId,
      moduleName: booksModule!,
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
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        moduleName: booksModule,
        recordId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.updateRecord({
      companyId: metadata.companyId,
      moduleName: booksModule!,
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
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        moduleName: booksModule,
        recordId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.deleteRecord({
      companyId: metadata.companyId,
      moduleName: booksModule!,
      recordId,
      organizationId,
    });
    return {
      ok: true,
      summary: `Deleted Zoho Books ${moduleName} record ${recordId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'importBankStatement') {
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        accountId: asString(payload.accountId),
        organizationId,
      }),
    });
    const result = await zohoBooksClient.importBankStatement({
      companyId: metadata.companyId,
      organizationId,
      body: asRecord(payload.body) ?? {},
    });
    return {
      ok: true,
      summary: `Imported bank statement into Zoho Books account ${asString(payload.accountId) ?? ''}.`.trim(),
      payload: result.payload,
    };
  }

  if (operation === 'activateBankAccount' || operation === 'deactivateBankAccount') {
    const accountId = asString(payload.accountId);
    if (!accountId) {
      throw new Error(`Stored Zoho Books ${operation} action is missing accountId`);
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        accountId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.setBankAccountStatus({
      companyId: metadata.companyId,
      organizationId,
      accountId,
      active: operation === 'activateBankAccount',
    });
    return {
      ok: true,
      summary: `${operation === 'activateBankAccount' ? 'Activated' : 'Deactivated'} Zoho Books bank account ${accountId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'matchBankTransaction') {
    const transactionId = asString(payload.transactionId);
    if (!transactionId) {
      throw new Error('Stored Zoho Books matchBankTransaction action is missing transactionId');
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        transactionId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.matchBankTransaction({
      companyId: metadata.companyId,
      organizationId,
      transactionId,
      body: asRecord(payload.body) ?? {},
    });
    return {
      ok: true,
      summary: `Matched Zoho Books bank transaction ${transactionId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'unmatchBankTransaction' || operation === 'excludeBankTransaction' || operation === 'restoreBankTransaction' || operation === 'uncategorizeBankTransaction') {
    const transactionId = asString(payload.transactionId);
    if (!transactionId) {
      throw new Error(`Stored Zoho Books ${operation} action is missing transactionId`);
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        transactionId,
        organizationId,
      }),
    });
    const body = asRecord(payload.body);
    const result = operation === 'unmatchBankTransaction'
      ? await zohoBooksClient.unmatchBankTransaction({
        companyId: metadata.companyId,
        organizationId,
        transactionId,
        body,
      })
      : operation === 'excludeBankTransaction'
        ? await zohoBooksClient.excludeBankTransaction({
          companyId: metadata.companyId,
          organizationId,
          transactionId,
          body,
        })
        : operation === 'restoreBankTransaction'
          ? await zohoBooksClient.restoreBankTransaction({
            companyId: metadata.companyId,
            organizationId,
            transactionId,
            body,
          })
          : await zohoBooksClient.uncategorizeBankTransaction({
            companyId: metadata.companyId,
            organizationId,
            transactionId,
            body,
          });
    return {
      ok: true,
      summary:
        operation === 'unmatchBankTransaction'
          ? `Unmatched Zoho Books bank transaction ${transactionId}.`
          : operation === 'excludeBankTransaction'
            ? `Excluded Zoho Books bank transaction ${transactionId}.`
            : operation === 'restoreBankTransaction'
              ? `Restored Zoho Books bank transaction ${transactionId}.`
              : `Uncategorized Zoho Books bank transaction ${transactionId}.`,
      payload: result.payload,
    };
  }

  if (
    operation === 'categorizeBankTransaction'
    || operation === 'categorizeBankTransactionAsExpense'
    || operation === 'categorizeBankTransactionAsVendorPayment'
    || operation === 'categorizeBankTransactionAsCustomerPayment'
    || operation === 'categorizeBankTransactionAsCreditNoteRefund'
  ) {
    const transactionId = asString(payload.transactionId);
    if (!transactionId) {
      throw new Error(`Stored Zoho Books ${operation} action is missing transactionId`);
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        transactionId,
        organizationId,
      }),
    });
    const category =
      operation === 'categorizeBankTransaction'
        ? 'general'
        : operation === 'categorizeBankTransactionAsExpense'
          ? 'expense'
          : operation === 'categorizeBankTransactionAsVendorPayment'
            ? 'vendorpayments'
            : operation === 'categorizeBankTransactionAsCustomerPayment'
              ? 'customerpayments'
              : 'creditnoterefunds';
    const result = await zohoBooksClient.categorizeBankTransaction({
      companyId: metadata.companyId,
      organizationId,
      transactionId,
      category,
      body: asRecord(payload.body) ?? {},
    });
    return {
      ok: true,
      summary:
        category === 'general'
          ? `Categorized Zoho Books bank transaction ${transactionId}.`
          : `Categorized Zoho Books bank transaction ${transactionId} as ${category}.`,
      payload: result.payload,
    };
  }

  if (operation === 'emailInvoice' || operation === 'remindInvoice') {
    const invoiceIdentifier = asString(payload.invoiceId);
    if (!invoiceIdentifier) {
      throw new Error(`Stored Zoho Books ${operation} action is missing invoiceId`);
    }
    const { recordId: invoiceId } = await resolveZohoBooksRecordIdentifier({
      companyId: metadata.companyId,
      organizationId,
      moduleName: 'invoices',
      identifier: invoiceIdentifier,
      requesterEmail: metadata.requesterEmail,
      requesterAiRole: metadata.requesterAiRole,
    });
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        invoiceId,
        organizationId,
      }),
    });
    const result = operation === 'emailInvoice'
      ? await zohoBooksClient.emailInvoice({
        companyId: metadata.companyId,
        organizationId,
        invoiceId,
        body: asRecord(payload.body) ?? {},
      })
      : await zohoBooksClient.remindInvoice({
        companyId: metadata.companyId,
        organizationId,
        invoiceId,
        body: asRecord(payload.body) ?? {},
      });
    return {
      ok: true,
      summary: `${operation === 'emailInvoice' ? 'Emailed' : 'Sent reminder for'} Zoho Books invoice ${invoiceIdentifier}.`,
      payload: result.payload,
    };
  }

  if (operation === 'enableInvoicePaymentReminder' || operation === 'disableInvoicePaymentReminder') {
    const invoiceIdentifier = asString(payload.invoiceId);
    if (!invoiceIdentifier) {
      throw new Error(`Stored Zoho Books ${operation} action is missing invoiceId`);
    }
    const { recordId: invoiceId } = await resolveZohoBooksRecordIdentifier({
      companyId: metadata.companyId,
      organizationId,
      moduleName: 'invoices',
      identifier: invoiceIdentifier,
      requesterEmail: metadata.requesterEmail,
      requesterAiRole: metadata.requesterAiRole,
    });
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        invoiceId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.setInvoicePaymentReminderEnabled({
      companyId: metadata.companyId,
      organizationId,
      invoiceId,
      enabled: operation === 'enableInvoicePaymentReminder',
    });
    return {
      ok: true,
      summary: `${operation === 'enableInvoicePaymentReminder' ? 'Enabled' : 'Disabled'} payment reminders for Zoho Books invoice ${invoiceIdentifier}.`,
      payload: result.payload,
    };
  }

  if (operation === 'writeOffInvoice' || operation === 'cancelInvoiceWriteOff') {
    const invoiceIdentifier = asString(payload.invoiceId);
    if (!invoiceIdentifier) {
      throw new Error(`Stored Zoho Books ${operation} action is missing invoiceId`);
    }
    const { recordId: invoiceId } = await resolveZohoBooksRecordIdentifier({
      companyId: metadata.companyId,
      organizationId,
      moduleName: 'invoices',
      identifier: invoiceIdentifier,
      requesterEmail: metadata.requesterEmail,
      requesterAiRole: metadata.requesterAiRole,
    });
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        invoiceId,
        organizationId,
      }),
    });
    const result = operation === 'writeOffInvoice'
      ? await zohoBooksClient.writeOffInvoice({
        companyId: metadata.companyId,
        organizationId,
        invoiceId,
        body: asRecord(payload.body),
      })
      : await zohoBooksClient.cancelInvoiceWriteOff({
        companyId: metadata.companyId,
        organizationId,
        invoiceId,
        body: asRecord(payload.body),
      });
    return {
      ok: true,
      summary: `${operation === 'writeOffInvoice' ? 'Wrote off' : 'Cancelled write off for'} Zoho Books invoice ${invoiceIdentifier}.`,
      payload: result.payload,
    };
  }

  if (operation === 'markInvoiceSent' || operation === 'voidInvoice' || operation === 'markInvoiceDraft' || operation === 'submitInvoice' || operation === 'approveInvoice') {
    const invoiceIdentifier = asString(payload.invoiceId);
    if (!invoiceIdentifier) {
      throw new Error(`Stored Zoho Books ${operation} action is missing invoiceId`);
    }
    const { recordId: invoiceId } = await resolveZohoBooksRecordIdentifier({
      companyId: metadata.companyId,
      organizationId,
      moduleName: 'invoices',
      identifier: invoiceIdentifier,
      requesterEmail: metadata.requesterEmail,
      requesterAiRole: metadata.requesterAiRole,
    });
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        invoiceId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.transitionInvoice({
      companyId: metadata.companyId,
      organizationId,
      invoiceId,
      action:
        operation === 'markInvoiceSent'
          ? 'markSent'
          : operation === 'voidInvoice'
            ? 'markVoid'
            : operation === 'markInvoiceDraft'
              ? 'markDraft'
              : operation === 'submitInvoice'
                ? 'submit'
                : 'approve',
      body: asRecord(payload.body),
    });
    return {
      ok: true,
      summary:
        operation === 'markInvoiceSent'
          ? `Marked Zoho Books invoice ${invoiceIdentifier} as sent.`
          : operation === 'voidInvoice'
            ? `Voided Zoho Books invoice ${invoiceIdentifier}.`
            : operation === 'markInvoiceDraft'
              ? `Marked Zoho Books invoice ${invoiceIdentifier} as draft.`
              : operation === 'submitInvoice'
                ? `Submitted Zoho Books invoice ${invoiceIdentifier} for approval.`
                : `Approved Zoho Books invoice ${invoiceIdentifier}.`,
      payload: result.payload,
    };
  }

  if (operation === 'emailEstimate') {
    const estimateId = asString(payload.estimateId);
    if (!estimateId) {
      throw new Error('Stored Zoho Books emailEstimate action is missing estimateId');
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        estimateId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.emailEstimate({
      companyId: metadata.companyId,
      organizationId,
      estimateId,
      body: asRecord(payload.body),
    });
    return {
      ok: true,
      summary: `Emailed Zoho Books estimate ${estimateId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'enableContactPaymentReminder' || operation === 'disableContactPaymentReminder') {
    const contactId = asString(payload.contactId);
    if (!contactId) {
      throw new Error(`Stored Zoho Books ${operation} action is missing contactId`);
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        contactId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.setContactPaymentReminderEnabled({
      companyId: metadata.companyId,
      organizationId,
      contactId,
      enabled: operation === 'enableContactPaymentReminder',
    });
    return {
      ok: true,
      summary: `${operation === 'enableContactPaymentReminder' ? 'Enabled' : 'Disabled'} payment reminders for Zoho Books contact ${contactId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'markEstimateSent' || operation === 'acceptEstimate' || operation === 'declineEstimate' || operation === 'submitEstimate' || operation === 'approveEstimate') {
    const estimateId = asString(payload.estimateId);
    if (!estimateId) {
      throw new Error(`Stored Zoho Books ${operation} action is missing estimateId`);
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        estimateId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.transitionEstimate({
      companyId: metadata.companyId,
      organizationId,
      estimateId,
      action:
        operation === 'markEstimateSent'
          ? 'markSent'
          : operation === 'acceptEstimate'
            ? 'markAccepted'
            : operation === 'declineEstimate'
              ? 'markDeclined'
              : operation === 'submitEstimate'
                ? 'submit'
                : 'approve',
      body: asRecord(payload.body),
    });
    return {
      ok: true,
      summary:
        operation === 'markEstimateSent'
          ? `Marked Zoho Books estimate ${estimateId} as sent.`
          : operation === 'acceptEstimate'
            ? `Marked Zoho Books estimate ${estimateId} as accepted.`
            : operation === 'declineEstimate'
              ? `Marked Zoho Books estimate ${estimateId} as declined.`
              : operation === 'submitEstimate'
                ? `Submitted Zoho Books estimate ${estimateId} for approval.`
                : `Approved Zoho Books estimate ${estimateId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'emailCreditNote') {
    const creditNoteId = asString(payload.creditNoteId);
    if (!creditNoteId) {
      throw new Error('Stored Zoho Books emailCreditNote action is missing creditNoteId');
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        creditNoteId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.emailCreditNote({
      companyId: metadata.companyId,
      organizationId,
      creditNoteId,
      body: asRecord(payload.body),
    });
    return {
      ok: true,
      summary: `Emailed Zoho Books credit note ${creditNoteId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'openCreditNote' || operation === 'voidCreditNote') {
    const creditNoteId = asString(payload.creditNoteId);
    if (!creditNoteId) {
      throw new Error(`Stored Zoho Books ${operation} action is missing creditNoteId`);
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        creditNoteId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.transitionCreditNote({
      companyId: metadata.companyId,
      organizationId,
      creditNoteId,
      action: operation === 'openCreditNote' ? 'markOpen' : 'markVoid',
      body: asRecord(payload.body),
    });
    return {
      ok: true,
      summary: `${operation === 'openCreditNote' ? 'Marked' : 'Voided'} Zoho Books credit note ${creditNoteId}${operation === 'openCreditNote' ? ' as open' : ''}.`,
      payload: result.payload,
    };
  }

  if (operation === 'refundCreditNote') {
    const creditNoteId = asString(payload.creditNoteId);
    if (!creditNoteId) {
      throw new Error('Stored Zoho Books refundCreditNote action is missing creditNoteId');
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        creditNoteId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.refundCreditNote({
      companyId: metadata.companyId,
      organizationId,
      creditNoteId,
      body: asRecord(payload.body) ?? {},
    });
    return {
      ok: true,
      summary: `Refunded Zoho Books credit note ${creditNoteId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'emailSalesOrder' || operation === 'openSalesOrder' || operation === 'voidSalesOrder' || operation === 'submitSalesOrder' || operation === 'approveSalesOrder' || operation === 'createInvoiceFromSalesOrder') {
    const salesOrderId = asString(payload.salesOrderId);
    if (!salesOrderId) {
      throw new Error(`Stored Zoho Books ${operation} action is missing salesOrderId`);
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        salesOrderId,
        organizationId,
      }),
    });
    const result = operation === 'emailSalesOrder'
      ? await zohoBooksClient.emailSalesOrder({
        companyId: metadata.companyId,
        organizationId,
        salesOrderId,
        body: asRecord(payload.body),
      })
      : operation === 'createInvoiceFromSalesOrder'
        ? await zohoBooksClient.createInvoiceFromSalesOrder({
          companyId: metadata.companyId,
          organizationId,
          salesOrderId,
          body: asRecord(payload.body),
        })
        : await zohoBooksClient.transitionSalesOrder({
          companyId: metadata.companyId,
          organizationId,
          salesOrderId,
          action:
            operation === 'openSalesOrder'
              ? 'markOpen'
              : operation === 'voidSalesOrder'
                ? 'markVoid'
                : operation === 'submitSalesOrder'
                  ? 'submit'
                  : 'approve',
          body: asRecord(payload.body),
        });
    return {
      ok: true,
      summary:
        operation === 'emailSalesOrder'
          ? `Emailed Zoho Books sales order ${salesOrderId}.`
          : operation === 'createInvoiceFromSalesOrder'
            ? `Created invoice from Zoho Books sales order ${salesOrderId}.`
            : operation === 'openSalesOrder'
              ? `Marked Zoho Books sales order ${salesOrderId} as open.`
              : operation === 'voidSalesOrder'
                ? `Voided Zoho Books sales order ${salesOrderId}.`
                : operation === 'submitSalesOrder'
                  ? `Submitted Zoho Books sales order ${salesOrderId} for approval.`
                  : `Approved Zoho Books sales order ${salesOrderId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'emailPurchaseOrder' || operation === 'openPurchaseOrder' || operation === 'billPurchaseOrder' || operation === 'cancelPurchaseOrder' || operation === 'rejectPurchaseOrder' || operation === 'submitPurchaseOrder' || operation === 'approvePurchaseOrder') {
    const purchaseOrderId = asString(payload.purchaseOrderId);
    if (!purchaseOrderId) {
      throw new Error(`Stored Zoho Books ${operation} action is missing purchaseOrderId`);
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        purchaseOrderId,
        organizationId,
      }),
    });
    const result = operation === 'emailPurchaseOrder'
      ? await zohoBooksClient.emailPurchaseOrder({
        companyId: metadata.companyId,
        organizationId,
        purchaseOrderId,
        body: asRecord(payload.body),
      })
      : await zohoBooksClient.transitionPurchaseOrder({
        companyId: metadata.companyId,
        organizationId,
        purchaseOrderId,
        action:
          operation === 'openPurchaseOrder'
            ? 'markOpen'
            : operation === 'billPurchaseOrder'
              ? 'markBilled'
              : operation === 'cancelPurchaseOrder'
                ? 'markCancelled'
                : operation === 'rejectPurchaseOrder'
                  ? 'reject'
                  : operation === 'submitPurchaseOrder'
                    ? 'submit'
                    : 'approve',
        body: asRecord(payload.body),
      });
    return {
      ok: true,
      summary:
        operation === 'emailPurchaseOrder'
          ? `Emailed Zoho Books purchase order ${purchaseOrderId}.`
          : operation === 'openPurchaseOrder'
            ? `Marked Zoho Books purchase order ${purchaseOrderId} as open.`
            : operation === 'billPurchaseOrder'
              ? `Marked Zoho Books purchase order ${purchaseOrderId} as billed.`
              : operation === 'cancelPurchaseOrder'
                ? `Cancelled Zoho Books purchase order ${purchaseOrderId}.`
                : operation === 'rejectPurchaseOrder'
                  ? `Rejected Zoho Books purchase order ${purchaseOrderId}.`
                  : operation === 'submitPurchaseOrder'
                    ? `Submitted Zoho Books purchase order ${purchaseOrderId} for approval.`
                    : `Approved Zoho Books purchase order ${purchaseOrderId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'addBooksComment' || operation === 'updateBooksComment' || operation === 'deleteBooksComment') {
    const recordId = asString(payload.recordId);
    const commentId = asString(payload.commentId);
    if (!booksModule || !recordId) {
      throw new Error(`Stored Zoho Books ${operation} action is missing module or recordId`);
    }
    if ((operation === 'updateBooksComment' || operation === 'deleteBooksComment') && !commentId) {
      throw new Error(`Stored Zoho Books ${operation} action is missing commentId`);
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        moduleName: booksModule,
        recordId,
        organizationId,
      }),
    });
    const result = operation === 'addBooksComment'
      ? await zohoBooksClient.addComment({
        companyId: metadata.companyId,
        organizationId,
        moduleName: booksModule as 'invoices' | 'estimates' | 'creditnotes' | 'bills' | 'salesorders' | 'purchaseorders',
        recordId,
        body: asRecord(payload.body) ?? {},
      })
      : operation === 'updateBooksComment'
        ? await zohoBooksClient.updateComment({
          companyId: metadata.companyId,
          organizationId,
          moduleName: booksModule as 'invoices' | 'estimates' | 'creditnotes' | 'bills' | 'salesorders' | 'purchaseorders',
          recordId,
          commentId: commentId!,
          body: asRecord(payload.body) ?? {},
        })
        : await zohoBooksClient.deleteComment({
          companyId: metadata.companyId,
          organizationId,
          moduleName: booksModule as 'invoices' | 'estimates' | 'creditnotes' | 'bills' | 'salesorders' | 'purchaseorders',
          recordId,
          commentId: commentId!,
        });
    return {
      ok: true,
      summary:
        operation === 'addBooksComment'
          ? `Added comment to Zoho Books ${moduleName} ${recordId}.`
          : operation === 'updateBooksComment'
            ? `Updated comment ${commentId} on Zoho Books ${moduleName} ${recordId}.`
            : `Deleted comment ${commentId} from Zoho Books ${moduleName} ${recordId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'applyBooksTemplate') {
    const recordId = asString(payload.recordId);
    const templateId = asString(payload.templateId);
    if (!booksModule || !recordId || !templateId) {
      throw new Error('Stored Zoho Books applyBooksTemplate action is missing module, recordId, or templateId');
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        moduleName: booksModule,
        recordId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.applyTemplate({
      companyId: metadata.companyId,
      organizationId,
      moduleName: booksModule as 'invoices' | 'estimates' | 'creditnotes' | 'bills' | 'salesorders' | 'purchaseorders',
      recordId,
      templateId,
    });
    return {
      ok: true,
      summary: `Applied template ${templateId} to Zoho Books ${moduleName} ${recordId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'uploadBooksAttachment') {
    const recordId = asString(payload.recordId);
    const fileName = asString(payload.fileName);
    const contentBase64 = asString(payload.contentBase64);
    if (!booksModule || !recordId || !fileName || !contentBase64) {
      throw new Error('Stored Zoho Books uploadBooksAttachment action is missing module, recordId, fileName, or contentBase64');
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        moduleName: booksModule,
        recordId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.uploadAttachment({
      companyId: metadata.companyId,
      organizationId,
      moduleName: booksModule as 'invoices' | 'estimates' | 'creditnotes' | 'bills' | 'salesorders' | 'purchaseorders',
      recordId,
      fileName,
      contentBase64,
      contentType: asString(payload.contentType),
    });
    return {
      ok: true,
      summary: `Uploaded an attachment to Zoho Books ${moduleName} ${recordId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'deleteBooksAttachment') {
    const recordId = asString(payload.recordId);
    if (!booksModule || !recordId) {
      throw new Error('Stored Zoho Books deleteBooksAttachment action is missing module or recordId');
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        moduleName: booksModule,
        recordId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.deleteAttachment({
      companyId: metadata.companyId,
      organizationId,
      moduleName: booksModule as 'invoices' | 'estimates' | 'creditnotes' | 'bills' | 'salesorders' | 'purchaseorders',
      recordId,
    });
    return {
      ok: true,
      summary: `Deleted the attachment from Zoho Books ${moduleName} ${recordId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'voidBill' || operation === 'openBill' || operation === 'submitBill' || operation === 'approveBill') {
    const billId = asString(payload.billId);
    if (!billId) {
      throw new Error(`Stored Zoho Books ${operation} action is missing billId`);
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        billId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.transitionBill({
      companyId: metadata.companyId,
      organizationId,
      billId,
      action:
        operation === 'voidBill'
          ? 'markVoid'
          : operation === 'openBill'
            ? 'markOpen'
            : operation === 'submitBill'
              ? 'submit'
              : 'approve',
      body: asRecord(payload.body),
    });
    return {
      ok: true,
      summary:
        operation === 'voidBill'
          ? `Voided Zoho Books bill ${billId}.`
          : operation === 'openBill'
            ? `Marked Zoho Books bill ${billId} as open.`
            : operation === 'submitBill'
              ? `Submitted Zoho Books bill ${billId} for approval.`
              : `Approved Zoho Books bill ${billId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'emailContact' || operation === 'emailContactStatement') {
    const contactId = asString(payload.contactId);
    if (!contactId) {
      throw new Error(`Stored Zoho Books ${operation} action is missing contactId`);
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        contactId,
        organizationId,
      }),
    });
    const result = operation === 'emailContact'
      ? await zohoBooksClient.emailContact({
        companyId: metadata.companyId,
        organizationId,
        contactId,
        body: asRecord(payload.body) ?? {},
      })
      : await zohoBooksClient.emailContactStatement({
        companyId: metadata.companyId,
        organizationId,
        contactId,
        body: asRecord(payload.body) ?? {},
      });
    return {
      ok: true,
      summary: `${operation === 'emailContact' ? 'Emailed' : 'Emailed statement to'} Zoho Books contact ${contactId}.`,
      payload: result.payload,
    };
  }

  if (operation === 'emailVendorPayment') {
    const vendorPaymentId = asString(payload.vendorPaymentId);
    if (!vendorPaymentId) {
      throw new Error('Stored Zoho Books emailVendorPayment action is missing vendorPaymentId');
    }
    await authorizeZohoMutationOrThrow({
      metadata,
      ...buildBooksMutationAuthorizationTarget({
        operation,
        vendorPaymentId,
        organizationId,
      }),
    });
    const result = await zohoBooksClient.emailVendorPayment({
      companyId: metadata.companyId,
      organizationId,
      vendorPaymentId,
      body: asRecord(payload.body) ?? {},
    });
    return {
      ok: true,
      summary: `Emailed Zoho Books vendor payment ${vendorPaymentId}.`,
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
  const actionGroup = asString(action.actionGroup) as ToolActionGroup | undefined;

  logger.info('hitl.remote_action.execute.start', {
    actionId: action.actionId,
    toolId,
    actionGroup,
    channel: action.channel,
  });

  await enforceCurrentToolPermission(action, { toolId, actionGroup });

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
