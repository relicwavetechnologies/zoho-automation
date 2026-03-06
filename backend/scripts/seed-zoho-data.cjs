#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();

const { PrismaClient } = require('../src/generated/prisma');
const { decryptZohoSecret, encryptZohoSecret } = require('../dist/company/integrations/zoho/zoho-token.crypto.js');
const { zohoSyncProducer } = require('../dist/company/queue/producer/zoho-sync.producer.js');
const { runZohoHistoricalSyncWorker } = require('../dist/company/queue/workers/zoho-historical.worker.js');

const prisma = new PrismaClient();

const COMPANY_ID = process.argv[2] || '2af7e2d1-e5f9-4bf3-8a13-59556de09a26';
const ENVIRONMENT = process.argv[3] || 'prod';

const nowStamp = new Date().toISOString().replace(/[:.]/g, '-');

const stagePool = ['Qualification', 'Needs Analysis', 'Proposal/Price Quote', 'Closed Won', 'Closed Lost'];
const priorityPool = ['High', 'Medium', 'Low'];

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
};

const createContactsPayload = (count) =>
  Array.from({ length: count }).map((_, idx) => {
    const i = idx + 1;
    return {
      First_Name: `Seed${i}`,
      Last_Name: `Contact_${nowStamp}_${i}`,
      Email: `seed.contact.${nowStamp}.${i}@example.com`,
      Phone: `+91-90000${String(1000 + i).slice(-4)}`,
      Description: `Seed contact ${i} for vectorization test run ${nowStamp}`,
    };
  });

const createDealsPayload = (count, contactIds) =>
  Array.from({ length: count }).map((_, idx) => {
    const i = idx + 1;
    const amount = 25000 + i * 15000;
    const closeDate = new Date(Date.now() + i * 86400000).toISOString().slice(0, 10);
    const stage = stagePool[idx % stagePool.length];
    const row = {
      Deal_Name: `Seed Deal ${nowStamp} #${i}`,
      Stage: stage,
      Amount: amount,
      Closing_Date: closeDate,
      Description: `Seed deal ${i} for retrieval and summarization testing.`,
    };
    if (contactIds.length > 0) {
      row.Contact_Name = contactIds[idx % contactIds.length];
    }
    return row;
  });

const createCasesPayload = (count, contactIds) =>
  Array.from({ length: count }).map((_, idx) => {
    const i = idx + 1;
    const row = {
      Subject: `Seed Case ${nowStamp} #${i}`,
      Status: i % 2 === 0 ? 'Open' : 'Escalated',
      Priority: priorityPool[idx % priorityPool.length],
      Description: `Seed case ${i} for retrieval grounding checks.`,
    };
    if (contactIds.length > 0) {
      row.Contact_Name = contactIds[idx % contactIds.length];
    }
    return row;
  });

const extractCreatedIds = (response) =>
  (response?.data || [])
    .filter((item) => item?.status === 'success')
    .map((item) => item?.details?.id)
    .filter((id) => typeof id === 'string' && id.length > 0);

async function insertModule(httpClient, accessToken, moduleName, rows) {
  const results = { moduleName, attempted: rows.length, created: 0, failed: 0, ids: [], errors: [] };
  for (const batch of chunk(rows, 50)) {
    const res = await httpClient.requestJson({
      base: 'api',
      path: `/crm/v2/${moduleName}`,
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
      body: { data: batch },
      retry: { maxAttempts: 2, baseDelayMs: 200 },
    });

    const ids = extractCreatedIds(res);
    results.ids.push(...ids);
    const batchFailed = Math.max(0, batch.length - ids.length);
    results.created += ids.length;
    results.failed += batchFailed;
    if (batchFailed > 0) {
      results.errors.push(JSON.stringify(res).slice(0, 700));
    }
  }
  return results;
}

async function postForm(url, form) {
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
    throw new Error(`Zoho token endpoint failed (${response.status}): ${raw.slice(0, 500)}`);
  }
  return payload;
}

async function requestJson(baseUrl, path, accessToken, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
    body: JSON.stringify(body),
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
    throw new Error(`Zoho API failed (${response.status}): ${raw.slice(0, 600)}`);
  }
  return payload;
}

async function main() {
  console.log(`[seed] starting for company=${COMPANY_ID} env=${ENVIRONMENT}`);

  const connection = await prisma.zohoConnection.findUnique({
    where: {
      companyId_environment: {
        companyId: COMPANY_ID,
        environment: ENVIRONMENT,
      },
    },
    select: {
      id: true,
      status: true,
      providerMode: true,
      accessTokenEncrypted: true,
      refreshTokenEncrypted: true,
      accessTokenExpiresAt: true,
      tokenMetadata: true,
      tokenCipherVersion: true,
    },
  });
  if (!connection || connection.status !== 'CONNECTED') {
    throw new Error(`Connected Zoho connection not found for ${COMPANY_ID}/${ENVIRONMENT}`);
  }
  if (connection.providerMode !== 'rest') {
    throw new Error(`Seeding is currently implemented for rest mode only. Found: ${connection.providerMode}`);
  }

  const oauthConfig = await prisma.zohoOAuthConfig.findUnique({
    where: { companyId: COMPANY_ID },
    select: {
      clientId: true,
      clientSecretEncrypted: true,
      accountsBaseUrl: true,
      apiBaseUrl: true,
    },
  });
  if (!oauthConfig) {
    throw new Error(`Missing Zoho OAuth config for company ${COMPANY_ID}`);
  }

  const clientId = oauthConfig.clientId;
  const clientSecret = decryptZohoSecret(oauthConfig.clientSecretEncrypted);
  const refreshToken = connection.refreshTokenEncrypted ? decryptZohoSecret(connection.refreshTokenEncrypted) : null;

  let accessToken =
    connection.accessTokenEncrypted && connection.accessTokenExpiresAt && connection.accessTokenExpiresAt.getTime() > Date.now() + 60000
      ? decryptZohoSecret(connection.accessTokenEncrypted)
      : null;

  if (!accessToken) {
    if (!refreshToken) {
      throw new Error('Missing refresh token to mint Zoho access token');
    }
    const tokenPayload = await postForm(
      `${oauthConfig.accountsBaseUrl.replace(/\/$/, '')}/oauth/v2/token`,
      {
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      },
    );
    accessToken = tokenPayload.access_token;
    if (!accessToken) {
      throw new Error(`Refresh token exchange failed: ${JSON.stringify(tokenPayload).slice(0, 500)}`);
    }
    const expiresIn = Number.parseInt(String(tokenPayload.expires_in ?? '3600'), 10);
    const encryptedAccess = encryptZohoSecret(accessToken);
    await prisma.zohoConnection.update({
      where: {
        companyId_environment: {
          companyId: COMPANY_ID,
          environment: ENVIRONMENT,
        },
      },
      data: {
        accessTokenEncrypted: encryptedAccess.cipherText,
        accessTokenExpiresAt: new Date(Date.now() + Math.max(300, expiresIn) * 1000),
        tokenCipherVersion: encryptedAccess.version,
        lastTokenRefreshAt: new Date(),
      },
    });
  }

  const apiBaseUrl = oauthConfig.apiBaseUrl;
  const httpClient = {
    requestJson: async ({ path, body }) => requestJson(apiBaseUrl, path, accessToken, body),
  };

  const contacts = await insertModule(httpClient, accessToken, 'Contacts', createContactsPayload(12));
  const deals = await insertModule(httpClient, accessToken, 'Deals', createDealsPayload(15, contacts.ids));
  const cases = await insertModule(httpClient, accessToken, 'Cases', createCasesPayload(10, contacts.ids));

  console.log('[seed] zoho insert summary');
  console.log(
    JSON.stringify(
      {
        contacts: { attempted: contacts.attempted, created: contacts.created, failed: contacts.failed },
        deals: { attempted: deals.attempted, created: deals.created, failed: deals.failed },
        cases: { attempted: cases.attempted, created: cases.created, failed: cases.failed },
      },
      null,
      2,
    ),
  );

  const queued = await zohoSyncProducer.enqueueInitialHistoricalSync({
    companyId: COMPANY_ID,
    connectionId: connection.id,
    trigger: 'seed_data_script',
  });
  await runZohoHistoricalSyncWorker(COMPANY_ID);

  const latestJob = await prisma.zohoSyncJob.findFirst({
    where: { companyId: COMPANY_ID, jobType: 'historical' },
    orderBy: { queuedAt: 'desc' },
    select: {
      id: true,
      status: true,
      progressPercent: true,
      processedBatches: true,
      totalBatches: true,
      errorMessage: true,
      finishedAt: true,
    },
  });

  console.log('[seed] historical sync status');
  console.log(
    JSON.stringify(
      {
        enqueued: queued.enqueued,
        jobId: queued.jobId,
        latestJob,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error('[seed] failed', error?.message || error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
