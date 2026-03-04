#!/usr/bin/env node

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const API_BASE_URL = process.env.LARK_API_BASE_URL || 'https://open.larksuite.com';

const fail = (message) => {
  console.error(`[lark-token] ${message}`);
  process.exit(1);
};

if (!APP_ID) {
  fail('Missing LARK_APP_ID in environment.');
}

if (!APP_SECRET) {
  fail('Missing LARK_APP_SECRET in environment.');
}

const endpoint = `${API_BASE_URL.replace(/\/$/, '')}/open-apis/auth/v3/tenant_access_token/internal`;

const main = async () => {
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: APP_ID,
        app_secret: APP_SECRET,
      }),
    });
  } catch (error) {
    fail(`Network error while requesting Lark token: ${error instanceof Error ? error.message : String(error)}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    fail(`Lark token API returned non-JSON response (HTTP ${response.status}).`);
  }

  if (!response.ok || payload?.code !== 0 || typeof payload?.tenant_access_token !== 'string') {
    fail(
      `Lark token API failed (HTTP ${response.status}) with payload: ${JSON.stringify(payload, null, 2)}`,
    );
  }

  const token = payload.tenant_access_token;
  const expiresIn = Number(payload.expire) || 0;
  const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : 'unknown';

  console.log('');
  console.log('[lark-token] Tenant access token generated successfully.');
  console.log(`[lark-token] Expires in: ${expiresIn} seconds`);
  console.log(`[lark-token] Expires at: ${expiresAt}`);
  console.log('');
  console.log('LARK_BOT_TENANT_ACCESS_TOKEN=' + token);
  console.log('');
  console.log('# export command (copy/paste):');
  console.log(`export LARK_BOT_TENANT_ACCESS_TOKEN='${token}'`);
  console.log('');
};

main().catch((error) => {
  fail(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
});
