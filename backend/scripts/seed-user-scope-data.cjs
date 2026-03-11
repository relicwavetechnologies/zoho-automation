#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();

const { PrismaClient } = require('../src/generated/prisma');
const { decryptZohoSecret, encryptZohoSecret } = require('../dist/company/integrations/zoho/zoho-token.crypto.js');
const { zohoSyncProducer } = require('../dist/company/queue/producer/zoho-sync.producer.js');
const { runZohoHistoricalSyncWorker } = require('../dist/company/queue/workers/zoho-historical.worker.js');

const prisma = new PrismaClient();

const TARGET_EMAILS = [
  'vabhi.verma2678@gmail.com',
  'anishsuman2305@gmail.com',
];

const ENVIRONMENT = process.argv[2] || 'prod';
const ARG_COMPANY_ID = process.argv[3] || '';
const RUN_SYNC = (process.argv[4] || 'true').toLowerCase() !== 'false';

const marker = new Date().toISOString().replace(/[:.]/g, '-');

const readCreatedIds = (response) =>
  (response?.data || [])
    .map((item) => item?.details?.id)
    .filter((id) => typeof id === 'string' && id.length > 0);

const postForm = async (url, form) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });
  const raw = await response.text();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
  }
  if (!response.ok) {
    throw new Error(`Zoho token endpoint failed (${response.status}): ${raw.slice(0, 700)}`);
  }
  return payload;
};

const requestZoho = async (baseUrl, accessToken, method, path, body) => {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await response.text();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
  }
  if (!response.ok) {
    throw new Error(`Zoho API failed (${response.status}) ${path}: ${raw.slice(0, 1200)}`);
  }
  return payload;
};

const buildCloseDate = (daysAhead) => {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
};

const ensureAccessToken = async (companyId, environment, oauthConfig, connection) => {
  const validAccessToken =
    connection.accessTokenEncrypted
    && connection.accessTokenExpiresAt
    && connection.accessTokenExpiresAt.getTime() > Date.now() + 60_000;

  if (validAccessToken) {
    return decryptZohoSecret(connection.accessTokenEncrypted);
  }

  if (!connection.refreshTokenEncrypted) {
    throw new Error('Refresh token is missing for this company connection');
  }

  const refreshToken = decryptZohoSecret(connection.refreshTokenEncrypted);
  const clientSecret = decryptZohoSecret(oauthConfig.clientSecretEncrypted);

  const tokenPayload = await postForm(
    `${oauthConfig.accountsBaseUrl.replace(/\/$/, '')}/oauth/v2/token`,
    {
      grant_type: 'refresh_token',
      client_id: oauthConfig.clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    },
  );

  const accessToken = tokenPayload.access_token;
  if (!accessToken) {
    throw new Error(`Refresh exchange missing access_token: ${JSON.stringify(tokenPayload).slice(0, 700)}`);
  }

  const expiresIn = Number.parseInt(String(tokenPayload.expires_in ?? '3600'), 10);
  const encrypted = encryptZohoSecret(accessToken);

  await prisma.zohoConnection.update({
    where: {
      companyId_environment: {
        companyId,
        environment,
      },
    },
    data: {
      accessTokenEncrypted: encrypted.cipherText,
      tokenCipherVersion: encrypted.version,
      accessTokenExpiresAt: new Date(Date.now() + Math.max(300, expiresIn) * 1000),
      lastTokenRefreshAt: new Date(),
    },
  });

  return accessToken;
};

async function resolveCompanyId() {
  if (ARG_COMPANY_ID) {
    return ARG_COMPANY_ID;
  }
  const connection = await prisma.zohoConnection.findFirst({
    where: { status: 'CONNECTED', environment: ENVIRONMENT },
    orderBy: { connectedAt: 'desc' },
    select: { companyId: true },
  });
  if (!connection?.companyId) {
    throw new Error(`No CONNECTED Zoho connection found for environment=${ENVIRONMENT}`);
  }
  return connection.companyId;
}

async function main() {
  const companyId = await resolveCompanyId();
  console.log(`[seed-user-scope] starting companyId=${companyId} env=${ENVIRONMENT} marker=${marker}`);

  const connection = await prisma.zohoConnection.findUnique({
    where: {
      companyId_environment: {
        companyId,
        environment: ENVIRONMENT,
      },
    },
    select: {
      id: true,
      status: true,
      accessTokenEncrypted: true,
      refreshTokenEncrypted: true,
      accessTokenExpiresAt: true,
    },
  });
  if (!connection || connection.status !== 'CONNECTED') {
    throw new Error(`Connected Zoho connection not found for company=${companyId} env=${ENVIRONMENT}`);
  }

  const oauthConfig = await prisma.zohoOAuthConfig.findUnique({
    where: { companyId },
    select: {
      clientId: true,
      clientSecretEncrypted: true,
      accountsBaseUrl: true,
      apiBaseUrl: true,
    },
  });
  if (!oauthConfig) {
    throw new Error(`Zoho OAuth config not found for company=${companyId}`);
  }

  const accessToken = await ensureAccessToken(companyId, ENVIRONMENT, oauthConfig, connection);
  const apiBaseUrl = oauthConfig.apiBaseUrl;

  const contactsPayload = TARGET_EMAILS.map((email, index) => ({
    First_Name: index === 0 ? 'Vabhi' : 'Anish',
    Last_Name: `StrictScope_${marker}_${index + 1}`,
    Email: email,
    Phone: `+91-9900${String(1000 + index)}`,
    Description: `Strict-scope seeded contact for ${email}. marker=${marker}`,
  }));
  const contactsRes = await requestZoho(apiBaseUrl, accessToken, 'POST', '/crm/v2/Contacts', {
    data: contactsPayload,
  });
  const contactIds = readCreatedIds(contactsRes);

  const leadsPayload = TARGET_EMAILS.map((email, index) => ({
    First_Name: index === 0 ? 'Vabhi' : 'Anish',
    Last_Name: `LeadStrict_${marker}_${index + 1}`,
    Company: index === 0 ? 'RelicWave Labs' : 'Xemiac Systems',
    Email: email,
    Lead_Status: 'Not Contacted',
    Description: `Strict-scope seeded lead for ${email}. marker=${marker}`,
  }));
  const leadsRes = await requestZoho(apiBaseUrl, accessToken, 'POST', '/crm/v2/Leads', {
    data: leadsPayload,
  });
  const leadIds = readCreatedIds(leadsRes);

  const dealsPayload = TARGET_EMAILS.map((email, index) => ({
    Deal_Name: `StrictScope Deal ${index + 1} ${marker}`,
    Stage: index === 0 ? 'Qualification' : 'Needs Analysis',
    Amount: 65000 + index * 18500,
    Closing_Date: buildCloseDate(14 + index * 7),
    Description: `Deal tied to ${email}. marker=${marker}`,
    ...(contactIds[index] ? { Contact_Name: { id: contactIds[index] } } : {}),
  }));
  const dealsRes = await requestZoho(apiBaseUrl, accessToken, 'POST', '/crm/v2/Deals', {
    data: dealsPayload,
  });
  const dealIds = readCreatedIds(dealsRes);

  const casesPayload = TARGET_EMAILS.map((email, index) => ({
    Subject: `StrictScope Case ${index + 1} ${marker}`,
    Status: index === 0 ? 'Open' : 'Escalated',
    Priority: index === 0 ? 'High' : 'Medium',
    Description: `Case for ${email}. marker=${marker}`,
    ...(contactIds[index] ? { Contact_Name: { id: contactIds[index] } } : {}),
  }));
  const casesRes = await requestZoho(apiBaseUrl, accessToken, 'POST', '/crm/v2/Cases', {
    data: casesPayload,
  });
  const caseIds = readCreatedIds(casesRes);

  let syncMeta = { ran: false };
  if (RUN_SYNC) {
    const enqueue = await zohoSyncProducer.enqueueInitialHistoricalSync({
      companyId,
      connectionId: connection.id,
      trigger: `seed_user_scope_${marker}`,
    });
    await runZohoHistoricalSyncWorker(companyId);
    syncMeta = {
      ran: true,
      enqueued: enqueue.enqueued,
      jobId: enqueue.jobId,
    };
  }

  const summary = {
    companyId,
    environment: ENVIRONMENT,
    marker,
    targetEmails: TARGET_EMAILS,
    created: {
      contacts: contactIds,
      leads: leadIds,
      deals: dealIds,
      cases: caseIds,
    },
    sync: syncMeta,
  };
  console.log('[seed-user-scope] success');
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error('[seed-user-scope] failed', error?.message || error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
