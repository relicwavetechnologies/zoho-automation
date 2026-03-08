#!/usr/bin/env node

const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { PrismaClient } = require('../src/generated/prisma');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const prisma = new PrismaClient();
const API_BASE_URL_DEFAULT = process.env.LARK_API_BASE_URL || 'https://open.larksuite.com';
const ENCRYPTION_KEY = (process.env.ZOHO_TOKEN_ENCRYPTION_KEY || '').trim();
const args = process.argv.slice(2);

const readArg = (name) => {
  const idx = args.indexOf(name);
  return idx === -1 ? undefined : args[idx + 1];
};

const fail = async (message, details) => {
  console.error(`[lark-docs-validate] ${message}`);
  if (details !== undefined) {
    console.error(JSON.stringify(details, null, 2));
  }
  await prisma.$disconnect();
  process.exit(1);
};

const info = (message, details) => {
  console.log(`[lark-docs-validate] ${message}`);
  if (details !== undefined) {
    console.log(JSON.stringify(details, null, 2));
  }
};

const toBuffer = (input) => {
  if (input.startsWith('base64:')) return Buffer.from(input.slice('base64:'.length), 'base64');
  return crypto.createHash('sha256').update(input).digest();
};

const decryptSecret = (cipherText) => {
  if (!cipherText) return undefined;
  if (!ENCRYPTION_KEY) throw new Error('ZOHO_TOKEN_ENCRYPTION_KEY is required');
  const parts = cipherText.trim().split(':');
  if (parts.length !== 4 || !parts[0].startsWith('v')) throw new Error('Invalid encrypted payload format');
  const key = toBuffer(ENCRYPTION_KEY);
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const encrypted = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
};

const asString = (value) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
};

const asRecord = (value) => {
  if (!value || typeof value !== 'object') return null;
  return value;
};

const requestJson = async ({ apiBaseUrl, token, method, reqPath, body }) => {
  const response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}${reqPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  return { response, payload };
};

const resolveCredentials = async () => {
  const companyId = readArg('--company-id');
  if (companyId) {
    const row = await prisma.larkWorkspaceConfig.findUnique({ where: { companyId } });
    if (!row) await fail(`No LarkWorkspaceConfig found for companyId=${companyId}`);
    return {
      source: 'workspace_config',
      companyId,
      appId: row.appId,
      appSecret: decryptSecret(row.appSecretEncrypted),
      staticTenantAccessToken: row.staticTenantAccessTokenEncrypted
        ? decryptSecret(row.staticTenantAccessTokenEncrypted)
        : undefined,
      apiBaseUrl: row.apiBaseUrl || API_BASE_URL_DEFAULT,
    };
  }

  return {
    source: 'env_fallback',
    companyId: undefined,
    appId: process.env.LARK_APP_ID,
    appSecret: process.env.LARK_APP_SECRET,
    staticTenantAccessToken: process.env.LARK_BOT_TENANT_ACCESS_TOKEN,
    apiBaseUrl: API_BASE_URL_DEFAULT,
  };
};

const getTenantToken = async (creds) => {
  if (creds.appId && creds.appSecret) {
    const endpoint = `${creds.apiBaseUrl.replace(/\/$/, '')}/open-apis/auth/v3/tenant_access_token/internal`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (response.ok && payload.code === 0 && typeof payload.tenant_access_token === 'string') {
      return { token: payload.tenant_access_token, mode: 'dynamic', expiresInSeconds: payload.expire };
    }
    info('Dynamic tenant token failed, will try static fallback if available', { statusCode: response.status, payload });
  }

  if (creds.staticTenantAccessToken) {
    return { token: creds.staticTenantAccessToken, mode: 'static' };
  }
  await fail('Unable to resolve usable tenant token');
};

const main = async () => {
  const creds = await resolveCredentials();
  const tokenInfo = await getTenantToken(creds);
  const title = readArg('--title') || `Lark Docs Validation ${new Date().toISOString()}`;

  info('Resolved credentials', {
    source: creds.source,
    companyId: creds.companyId || null,
    appId: creds.appId || null,
    apiBaseUrl: creds.apiBaseUrl,
    tokenMode: tokenInfo.mode,
    expiresInSeconds: tokenInfo.expiresInSeconds || null,
  });

  const create = await requestJson({
    apiBaseUrl: creds.apiBaseUrl,
    token: tokenInfo.token,
    method: 'POST',
    reqPath: '/open-apis/docx/v1/documents',
    body: { title },
  });

  info('Create document response', { statusCode: create.response.status, payload: create.payload });
  if (!create.response.ok || create.payload.code !== 0) {
    await fail('Create document failed', { statusCode: create.response.status, payload: create.payload });
  }

  const document = asRecord(create.payload.data?.document) || {};
  const documentId = asString(document.document_id) || asString(create.payload.data?.document_id);
  if (!documentId) {
    await fail('Create document succeeded but document_id was missing', create.payload);
  }

  const blocksList = await requestJson({
    apiBaseUrl: creds.apiBaseUrl,
    token: tokenInfo.token,
    method: 'GET',
    reqPath: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks`,
  });

  info('List root blocks response', { statusCode: blocksList.response.status, payload: blocksList.payload });
  if (!blocksList.response.ok || blocksList.payload.code !== 0) {
    await fail('List blocks failed', { statusCode: blocksList.response.status, payload: blocksList.payload });
  }

  const items = Array.isArray(blocksList.payload.data?.items) ? blocksList.payload.data.items : [];
  const rootBlockId = asString(asRecord(items[0])?.block_id) || documentId;

  const append = await requestJson({
    apiBaseUrl: creds.apiBaseUrl,
    token: tokenInfo.token,
    method: 'POST',
    reqPath: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(rootBlockId)}/children`,
    body: {
      children: [
        { block_type: 2, heading1: { elements: [{ text_run: { content: title } }] } },
        { block_type: 11, text: { elements: [{ text_run: { content: 'Validation paragraph from backend/scripts/validate-lark-docs.cjs' } }] } },
        { block_type: 12, bullet: { elements: [{ text_run: { content: `Source: ${creds.source}` } }] } },
        { block_type: 12, bullet: { elements: [{ text_run: { content: `Token mode: ${tokenInfo.mode}` } }] } },
      ],
      index: 0,
    },
  });

  info('Append blocks response', { statusCode: append.response.status, payload: append.payload });
  if (!append.response.ok || append.payload.code !== 0) {
    await fail('Append blocks failed', { statusCode: append.response.status, payload: append.payload });
  }

  const url = asString(document.url) || `https://docs.larksuite.com/docx/${documentId}`;
  console.log('');
  console.log('LARK_DOCS_VALIDATE_RESULT=' + JSON.stringify({
    source: creds.source,
    appId: creds.appId || null,
    documentId,
    rootBlockId,
    url,
  }));
  console.log('');

  await prisma.$disconnect();
};

main().catch(async (error) => {
  await fail(error instanceof Error ? error.message : String(error));
});
