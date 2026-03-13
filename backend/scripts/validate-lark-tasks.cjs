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
  console.error(`[lark-tasks-validate] ${message}`);
  if (details !== undefined) {
    console.error(JSON.stringify(details, null, 2));
  }
  await prisma.$disconnect();
  process.exit(1);
};

const info = (message, details) => {
  console.log(`[lark-tasks-validate] ${message}`);
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

const asArray = (value) => (Array.isArray(value) ? value : []);

const requestJson = async ({ apiBaseUrl, token, method, reqPath, body, query }) => {
  const url = new URL(`${apiBaseUrl.replace(/\/$/, '')}${reqPath}`);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      const normalized = typeof value === 'string' ? value.trim() : String(value);
      if (!normalized) continue;
      url.searchParams.set(key, normalized);
    }
  }

  const response = await fetch(url, {
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
  if (!companyId) {
    await fail('Pass --company-id so the script can resolve the correct workspace and linked user.');
  }

  const link = await prisma.larkUserAuthLink.findFirst({
    where: { companyId, revokedAt: null },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      userId: true,
      companyId: true,
      larkEmail: true,
      accessTokenEncrypted: true,
      accessTokenExpiresAt: true,
    },
  });

  if (link) {
    return {
      source: 'linked_user',
      companyId,
      userId: link.userId,
      larkEmail: link.larkEmail,
      apiBaseUrl: API_BASE_URL_DEFAULT,
      accessToken: decryptSecret(link.accessTokenEncrypted),
      accessTokenExpiresAt: link.accessTokenExpiresAt,
    };
  }

  const row = await prisma.larkWorkspaceConfig.findUnique({
    where: { companyId },
    select: {
      appId: true,
      appSecretEncrypted: true,
      staticTenantAccessTokenEncrypted: true,
      apiBaseUrl: true,
    },
  });

  if (!row) {
    await fail(`No linked Lark user or workspace config found for companyId=${companyId}`);
  }

  return {
    source: 'workspace_config',
    companyId,
    apiBaseUrl: row.apiBaseUrl || API_BASE_URL_DEFAULT,
    appId: row.appId,
    appSecret: decryptSecret(row.appSecretEncrypted),
    staticTenantAccessToken: row.staticTenantAccessTokenEncrypted
      ? decryptSecret(row.staticTenantAccessTokenEncrypted)
      : undefined,
  };
};

const getTenantToken = async (creds) => {
  if (creds.source === 'linked_user') {
    return {
      token: creds.accessToken,
      mode: 'linked_user',
    };
  }

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
      return { token: payload.tenant_access_token, mode: 'dynamic_tenant', expiresInSeconds: payload.expire };
    }
    info('Dynamic tenant token failed, will try static fallback if available', {
      statusCode: response.status,
      payload,
    });
  }

  if (creds.staticTenantAccessToken) {
    return { token: creds.staticTenantAccessToken, mode: 'static_tenant' };
  }

  await fail('Unable to resolve usable Lark credentials for tasks validation');
};

const normalizeTasklist = (value) => {
  const record = asRecord(value);
  if (!record) return null;
  const tasklistId = asString(record.tasklist_id) || asString(record.tasklistId) || asString(record.guid) || asString(record.id);
  if (!tasklistId) return null;
  return {
    tasklistId,
    summary: asString(record.summary) || asString(record.title) || asString(record.name),
    raw: record,
  };
};

const normalizeTask = (value) => {
  const record = asRecord(value);
  if (!record) return null;
  const taskId = asString(record.task_id) || asString(record.taskId) || asString(record.guid) || asString(record.id);
  if (!taskId) return null;
  return {
    taskId,
    taskGuid: asString(record.guid) || asString(record.task_guid) || asString(record.taskGuid),
    summary: asString(record.summary) || asString(record.title),
    raw: record,
  };
};

const pickArray = (payload, keys) => {
  for (const key of keys) {
    const arr = asArray(payload?.data?.[key]);
    if (arr.length > 0) return arr;
  }
  return [];
};

const main = async () => {
  const creds = await resolveCredentials();
  const tokenInfo = await getTenantToken(creds);

  info('Resolved credentials', {
    source: creds.source,
    companyId: creds.companyId,
    userId: creds.userId || null,
    larkEmail: creds.larkEmail || null,
    apiBaseUrl: creds.apiBaseUrl,
    tokenMode: tokenInfo.mode,
    expiresInSeconds: tokenInfo.expiresInSeconds || null,
    accessTokenExpiresAt: creds.accessTokenExpiresAt || null,
  });

  const listTasklists = await requestJson({
    apiBaseUrl: creds.apiBaseUrl,
    token: tokenInfo.token,
    method: 'GET',
    reqPath: '/open-apis/task/v2/tasklists',
  });
  info('List tasklists response', { statusCode: listTasklists.response.status, payload: listTasklists.payload });

  const tasklistItems = pickArray(listTasklists.payload, ['items', 'tasklists', 'tasklist_list'])
    .map((item) => normalizeTasklist(item))
    .filter(Boolean);

  const listTasks = await requestJson({
    apiBaseUrl: creds.apiBaseUrl,
    token: tokenInfo.token,
    method: 'GET',
    reqPath: '/open-apis/task/v2/tasks',
  });
  info('List tasks response', { statusCode: listTasks.response.status, payload: listTasks.payload });

  const taskItems = pickArray(listTasks.payload, ['items', 'tasks'])
    .map((item) => normalizeTask(item))
    .filter(Boolean);

  let getTask = null;
  if (taskItems.length > 0) {
    const firstTaskGuid = taskItems[0].taskGuid || taskItems[0].taskId;
    getTask = await requestJson({
      apiBaseUrl: creds.apiBaseUrl,
      token: tokenInfo.token,
      method: 'GET',
      reqPath: `/open-apis/task/v2/tasks/${encodeURIComponent(firstTaskGuid)}`,
    });
    info('Get task response', { statusCode: getTask.response.status, payload: getTask.payload });
  }

  const createTask = await requestJson({
    apiBaseUrl: creds.apiBaseUrl,
    token: tokenInfo.token,
    method: 'POST',
    reqPath: '/open-apis/task/v2/tasks',
    body: {
      summary: `Codex task validation ${new Date().toISOString()}`,
      description: 'Temporary task created by backend/scripts/validate-lark-tasks.cjs',
    },
  });
  info('Create task response', { statusCode: createTask.response.status, payload: createTask.payload });

  const createdTask = normalizeTask(createTask.payload?.data?.task || createTask.payload?.data?.item || createTask.payload?.data);

  let updateTask = null;
  let deleteTask = null;
  if (createdTask?.taskGuid || createdTask?.taskId) {
    const taskGuid = createdTask.taskGuid || createdTask.taskId;
    updateTask = await requestJson({
      apiBaseUrl: creds.apiBaseUrl,
      token: tokenInfo.token,
      method: 'PATCH',
      reqPath: `/open-apis/task/v2/tasks/${encodeURIComponent(taskGuid)}`,
      body: {
        task: {
          summary: `${createdTask.summary || 'Codex task validation'} [updated]`,
          completed_at: String(Date.now()),
        },
        update_fields: ['summary', 'completed_at'],
      },
    });
    info('Update task response', { statusCode: updateTask.response.status, payload: updateTask.payload });

    deleteTask = await requestJson({
      apiBaseUrl: creds.apiBaseUrl,
      token: tokenInfo.token,
      method: 'DELETE',
      reqPath: `/open-apis/task/v2/tasks/${encodeURIComponent(taskGuid)}`,
    });
    info('Delete task response', { statusCode: deleteTask.response.status, payload: deleteTask.payload });
  }

  console.log('');
  console.log('LARK_TASKS_VALIDATE_RESULT=' + JSON.stringify({
    source: creds.source,
    tokenMode: tokenInfo.mode,
    tasklists: tasklistItems.slice(0, 5),
    tasks: taskItems.slice(0, 5),
    singleTaskStatusCode: getTask?.response.status ?? null,
    singleTaskPayloadCode: getTask?.payload?.code ?? null,
    createTaskStatusCode: createTask.response.status,
    createTaskPayloadCode: createTask.payload?.code ?? null,
    updateTaskStatusCode: updateTask?.response.status ?? null,
    updateTaskPayloadCode: updateTask?.payload?.code ?? null,
    deleteTaskStatusCode: deleteTask?.response.status ?? null,
    deleteTaskPayloadCode: deleteTask?.payload?.code ?? null,
  }));
  console.log('');

  await prisma.$disconnect();
};

main().catch(async (error) => {
  await fail(error instanceof Error ? error.message : String(error));
});
