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
  console.error(`[lark-calendar-validate] ${message}`);
  if (details !== undefined) {
    console.error(JSON.stringify(details, null, 2));
  }
  await prisma.$disconnect();
  process.exit(1);
};

const info = (message, details) => {
  console.log(`[lark-calendar-validate] ${message}`);
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
      userId: true,
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

  await fail(`No linked Lark user found for companyId=${companyId}`);
};

const main = async () => {
  const creds = await resolveCredentials();
  const token = creds.accessToken;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const startTime = String(nowSeconds + 1800);
  const endTime = String(nowSeconds + 3600);
  const updatedStartTime = String(nowSeconds + 5400);
  const updatedEndTime = String(nowSeconds + 7200);

  info('Resolved credentials', {
    source: creds.source,
    companyId: creds.companyId,
    userId: creds.userId,
    larkEmail: creds.larkEmail,
    apiBaseUrl: creds.apiBaseUrl,
    accessTokenExpiresAt: creds.accessTokenExpiresAt || null,
  });

  const primary = await requestJson({
    apiBaseUrl: creds.apiBaseUrl,
    token,
    method: 'POST',
    reqPath: '/open-apis/calendar/v4/calendars/primary',
  });
  info('Primary calendar response', { statusCode: primary.response.status, payload: primary.payload });

  const calendarId =
    primary.payload?.data?.calendars?.[0]?.calendar?.calendar_id
    || primary.payload?.data?.calendar?.calendar_id;
  if (!calendarId) {
    await fail('Primary calendar lookup returned no calendar_id', primary.payload);
  }

  const createEvent = await requestJson({
    apiBaseUrl: creds.apiBaseUrl,
    token,
    method: 'POST',
    reqPath: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`,
    body: {
      summary: `Codex calendar validation ${new Date().toISOString()}`,
      description: 'Temporary event created by backend/scripts/validate-lark-calendar.cjs',
      start_time: { timestamp: startTime },
      end_time: { timestamp: endTime },
    },
  });
  info('Create event response', { statusCode: createEvent.response.status, payload: createEvent.payload });

  const event = createEvent.payload?.data?.event || createEvent.payload?.data?.item || createEvent.payload?.data;
  const eventId = event?.event_id || event?.eventId || event?.id;
  if (!eventId) {
    await fail('Calendar create returned no event_id', createEvent.payload);
  }

  const listEvents = await requestJson({
    apiBaseUrl: creds.apiBaseUrl,
    token,
    method: 'GET',
    reqPath: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`,
    query: {
      start_time: String(nowSeconds),
      end_time: String(nowSeconds + 10_800),
      page_size: 50,
    },
  });
  info('List events response', { statusCode: listEvents.response.status, payload: listEvents.payload });

  const updateEvent = await requestJson({
    apiBaseUrl: creds.apiBaseUrl,
    token,
    method: 'PATCH',
    reqPath: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    body: {
      summary: `${event.summary || 'Codex calendar validation'} [updated]`,
      start_time: { timestamp: updatedStartTime },
      end_time: { timestamp: updatedEndTime },
    },
  });
  info('Update event response', { statusCode: updateEvent.response.status, payload: updateEvent.payload });

  const deleteEvent = await requestJson({
    apiBaseUrl: creds.apiBaseUrl,
    token,
    method: 'DELETE',
    reqPath: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  });
  info('Delete event response', { statusCode: deleteEvent.response.status, payload: deleteEvent.payload });

  console.log('');
  console.log('LARK_CALENDAR_VALIDATE_RESULT=' + JSON.stringify({
    calendarId,
    createStatusCode: createEvent.response.status,
    createPayloadCode: createEvent.payload?.code ?? null,
    listStatusCode: listEvents.response.status,
    listPayloadCode: listEvents.payload?.code ?? null,
    updateStatusCode: updateEvent.response.status,
    updatePayloadCode: updateEvent.payload?.code ?? null,
    deleteStatusCode: deleteEvent.response.status,
    deletePayloadCode: deleteEvent.payload?.code ?? null,
  }));
  console.log('');

  await prisma.$disconnect();
};

main().catch(async (error) => {
  await fail(error instanceof Error ? error.message : String(error));
});
