const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');

const config = require('../dist/config').default;
const { DesktopAuthService } = require('../dist/modules/desktop-auth/desktop-auth.service');
const { larkOAuthService } = require('../dist/company/channels/lark/lark-oauth.service');
const { larkTenantBindingRepository } = require('../dist/company/channels/lark/lark-tenant-binding.repository');
const { larkUserAuthLinkRepository } = require('../dist/company/channels/lark/lark-user-auth-link.repository');
const { channelIdentityRepository } = require('../dist/company/channels/channel-identity.repository');
const { memberAuthService } = require('../dist/modules/member-auth/member-auth.service');

const originalMethods = {
  isConfigured: larkOAuthService.isConfigured,
  getRedirectUri: larkOAuthService.getRedirectUri,
  getAuthorizeUrl: larkOAuthService.getAuthorizeUrl,
  exchangeAuthorizationCode: larkOAuthService.exchangeAuthorizationCode,
  fetchUserInfo: larkOAuthService.fetchUserInfo,
  resolveCompanyId: larkTenantBindingRepository.resolveCompanyId,
  upsertLink: larkUserAuthLinkRepository.upsert,
  upsertIdentity: channelIdentityRepository.upsert,
  issueDesktopSession: memberAuthService.issueDesktopSession,
};

test.afterEach(() => {
  larkOAuthService.isConfigured = originalMethods.isConfigured;
  larkOAuthService.getRedirectUri = originalMethods.getRedirectUri;
  larkOAuthService.getAuthorizeUrl = originalMethods.getAuthorizeUrl;
  larkOAuthService.exchangeAuthorizationCode = originalMethods.exchangeAuthorizationCode;
  larkOAuthService.fetchUserInfo = originalMethods.fetchUserInfo;
  larkTenantBindingRepository.resolveCompanyId = originalMethods.resolveCompanyId;
  larkUserAuthLinkRepository.upsert = originalMethods.upsertLink;
  channelIdentityRepository.upsert = originalMethods.upsertIdentity;
  memberAuthService.issueDesktopSession = originalMethods.issueDesktopSession;
});

test('DesktopAuthService creates desktop Lark authorize URL', async () => {
  larkOAuthService.isConfigured = () => true;
  larkOAuthService.getRedirectUri = () => 'https://api.example.com/api/desktop/auth/lark/callback';
  larkOAuthService.getAuthorizeUrl = ({ state, redirectUri }) =>
    `https://open.larksuite.com/open-apis/authen/v1/index?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  const service = new DesktopAuthService();
  const result = await service.createLarkAuthorizeUrl();

  assert.equal(result.redirectUri, 'https://api.example.com/api/desktop/auth/lark/callback');
  assert.match(result.authorizeUrl, /^https:\/\/open\.larksuite\.com\/open-apis\/authen\/v1\/index\?/);
});

test('DesktopAuthService exchanges desktop Lark auth for an existing member session', async () => {
  larkOAuthService.exchangeAuthorizationCode = async () => ({
    accessToken: 'user-token',
    expiresIn: 3600,
  });
  larkOAuthService.fetchUserInfo = async () => ({
    tenantKey: 'tenant-1',
    openId: 'ou_123',
    userId: 'u_123',
    email: 'member@example.com',
    name: 'Member',
  });
  larkTenantBindingRepository.resolveCompanyId = async () => 'company-1';
  larkUserAuthLinkRepository.upsert = async () => ({ id: 'link-1' });
  channelIdentityRepository.upsert = async () => ({ id: 'identity-1', isNew: false });
  memberAuthService.issueDesktopSession = async (_userId, _companyId, _role, options) => ({
    token: 'desktop-token',
    session: {
      userId: 'user-1',
      companyId: 'company-1',
      role: 'MEMBER',
      sessionId: 'session-1',
      expiresAt: new Date().toISOString(),
      authProvider: options.authProvider,
      email: 'member@example.com',
      larkTenantKey: options.larkTenantKey,
      larkOpenId: options.larkOpenId,
      larkUserId: options.larkUserId,
    },
  });

  const service = new DesktopAuthService(
    { createHandoff: async () => undefined, findHandoffByCode: async () => null, consumeHandoff: async () => undefined },
    {
      findUserByEmailInsensitive: async () => ({ id: 'user-1', email: 'member@example.com' }),
      findActiveMembership: async () => ({ companyId: 'company-1', role: 'MEMBER' }),
    },
  );

  const state = jwt.sign({ kind: 'desktop_lark_login', nonce: 'abc' }, config.JWT_SECRET, {
    expiresIn: '10m',
  });
  const result = await service.exchangeLarkAuthorizationCode({ code: 'oauth-code', state });

  assert.equal(result.token, 'desktop-token');
  assert.equal(result.session.authProvider, 'lark');
  assert.equal(result.session.larkOpenId, 'ou_123');
});

test('DesktopAuthService fails closed when Lark user is not an existing member of the company', async () => {
  larkOAuthService.exchangeAuthorizationCode = async () => ({ accessToken: 'user-token' });
  larkOAuthService.fetchUserInfo = async () => ({
    tenantKey: 'tenant-1',
    email: 'missing@example.com',
  });
  larkTenantBindingRepository.resolveCompanyId = async () => 'company-1';

  const service = new DesktopAuthService(
    { createHandoff: async () => undefined, findHandoffByCode: async () => null, consumeHandoff: async () => undefined },
    {
      findUserByEmailInsensitive: async () => ({ id: 'user-1', email: 'missing@example.com' }),
      findActiveMembership: async () => null,
    },
  );

  const state = jwt.sign({ kind: 'desktop_lark_login', nonce: 'abc' }, config.JWT_SECRET, {
    expiresIn: '10m',
  });

  await assert.rejects(
    () => service.exchangeLarkAuthorizationCode({ code: 'oauth-code', state }),
    /not an active member of this company/i,
  );
});
