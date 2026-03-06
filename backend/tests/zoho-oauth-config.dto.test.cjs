const assert = require('node:assert/strict');
const test = require('node:test');

const { upsertZohoOAuthConfigSchema } = require('../dist/modules/company-admin/dto/connect-onboarding.dto');

test('upsertZohoOAuthConfigSchema rejects MCP/message URL in apiBaseUrl', () => {
  const result = upsertZohoOAuthConfigSchema.safeParse({
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'http://localhost:5173/zoho/callback',
    accountsBaseUrl: 'https://accounts.zoho.in',
    apiBaseUrl: 'https://example.zohomcp.in/mcp/message?key=abc',
  });

  assert.equal(result.success, false);
  if (result.success) {
    return;
  }
  assert.ok(result.error.issues.some((issue) => issue.path.join('.') === 'apiBaseUrl'));
});

test('upsertZohoOAuthConfigSchema accepts standard Zoho REST URLs', () => {
  const result = upsertZohoOAuthConfigSchema.safeParse({
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'http://localhost:5173/zoho/callback',
    accountsBaseUrl: 'https://accounts.zoho.in',
    apiBaseUrl: 'https://www.zohoapis.in',
  });

  assert.equal(result.success, true);
});
