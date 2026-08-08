import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProductionEnv,
  type TypedEnv,
} from '../../src/config/env.ts';
import { resolveApprovalGateOptions } from '../../src/composition.ts';

const production = (overrides: Partial<TypedEnv> = {}): TypedEnv => ({
  NODE_ENV: 'production',
  KNOWLEDGE_FILE_MALWARE_SCAN_MODE: 'required',
  ADMIN_JWT_SECRET: 'admin-'.padEnd(40, 'a'),
  MEMBER_JWT_SECRET: 'member-'.padEnd(40, 'b'),
  LARK_WEBHOOK_SIGNING_SECRET: 'lark-signing-secret',
  LARK_ENCRYPT_KEY: undefined,
  LARK_VERIFICATION_TOKEN: undefined,
  DIVO_APPROVAL_DISABLE_MANAGER_SELF_BYPASS: false,
  DIVO_HITL_TEST_DISABLE_MANAGER_SELF_BYPASS: false,
  PI_LARK_CONTROLLER_URL: 'http://divo-pi-controller:4317',
  HINDSIGHT_ENABLED: true,
  HINDSIGHT_API_KEY: 'private-hindsight-key',
  OPENROUTER_API_KEY: 'private-openrouter-key',
  CLOUDINARY_CLOUD_NAME: 'private-cloud',
  CLOUDINARY_API_KEY: 'private-key',
  CLOUDINARY_API_SECRET: 'private-secret',
  SHOPIFY_CLIENT_ID: 'shopify-client-id',
  SHOPIFY_CLIENT_SECRET: 'shopify-client-secret',
  SHOPIFY_REDIRECT_URI: 'https://backend.example.test/api/shopify/auth/callback',
  SHOPIFY_SCOPES: 'read_reports',
  SHOPIFY_PROTECTED_DATA_TOOLS_ENABLED: false,
  INTEGRATION_TOKEN_ENCRYPTION_KEY: 'integration-'.padEnd(40, 'k'),
  ...overrides,
} as TypedEnv);

describe('production environment safety', () => {
  it('accepts a separated private production topology', () => {
    assert.deepEqual(validateProductionEnv(production()), []);
  });

  it('rejects bypassed scanning, dev JWTs, loopback controller, and partial storage credentials', () => {
    const issues = validateProductionEnv(production({
      KNOWLEDGE_FILE_MALWARE_SCAN_MODE: 'disabled',
      ADMIN_JWT_SECRET: 'dev-secret-change-me',
      MEMBER_JWT_SECRET: 'dev-secret-change-me',
      LARK_WEBHOOK_SIGNING_SECRET: undefined,
      PI_LARK_CONTROLLER_URL: 'http://127.0.0.1:4317',
      HINDSIGHT_API_KEY: undefined,
      CLOUDINARY_API_SECRET: undefined,
    }));
    assert.equal(issues.length, 8);
    assert.ok(issues.some(issue => issue.includes('MALWARE_SCAN_MODE')));
    assert.ok(issues.some(issue => issue.includes('different')));
    assert.ok(issues.some(issue => issue.includes('Lark webhook')));
    assert.ok(issues.some(issue => issue.includes('controller')));
    assert.ok(issues.some(issue => issue.includes('Hindsight')));
    assert.ok(issues.some(issue => issue.includes('Cloudinary')));
  });

  it('does not impose production-only topology checks in local test mode', () => {
    assert.deepEqual(validateProductionEnv(production({ NODE_ENV: 'test' })), []);
  });

  it('uses the canonical four-eyes setting in production and ignores the legacy test switch there', () => {
    const productionPolicy = production({
      DIVO_APPROVAL_DISABLE_MANAGER_SELF_BYPASS: true,
      DIVO_HITL_TEST_DISABLE_MANAGER_SELF_BYPASS: true,
    });
    /*
     * `disableCompanyAdminExternalForwardExemption` is false throughout, and an
     * absent key has to produce `false` rather than `undefined` — an operator
     * handing over a partial env should get the exemption, not a third state
     * nothing downstream reads.
     */
    assert.deepEqual(resolveApprovalGateOptions(productionPolicy), {
      disableManagerSelfBypass: true,
      suppressCardDelivery: false,
      disableCompanyAdminExternalForwardExemption: false,
    });
    assert.deepEqual(validateProductionEnv(productionPolicy), []);

    assert.deepEqual(resolveApprovalGateOptions(production({
      DIVO_APPROVAL_DISABLE_MANAGER_SELF_BYPASS: false,
      DIVO_HITL_TEST_DISABLE_MANAGER_SELF_BYPASS: true,
    })), {
      disableManagerSelfBypass: false,
      suppressCardDelivery: false,
      disableCompanyAdminExternalForwardExemption: false,
    });

    assert.deepEqual(resolveApprovalGateOptions({
      NODE_ENV: 'test',
      DIVO_APPROVAL_DISABLE_MANAGER_SELF_BYPASS: false,
      DIVO_HITL_TEST_DISABLE_MANAGER_SELF_BYPASS: true,
    }), {
      disableManagerSelfBypass: true,
      suppressCardDelivery: false,
      disableCompanyAdminExternalForwardExemption: false,
    });
  });

  it('holds an admin to approval only when asked to, in production too', () => {
    // The exemption is a deliberate loosening, so the switch that takes it back
    // must work where it matters — unlike `suppressCardDelivery`, which is
    // ignored in production on purpose.
    assert.equal(
      resolveApprovalGateOptions(production({
        DIVO_MAIL_OPS_ADMIN_NEEDS_EXTERNAL_APPROVAL: true,
      })).disableCompanyAdminExternalForwardExemption,
      true,
    );
  });

  it('will not silence approval cards in production, whatever the switch says', () => {
    /*
     * The one property that makes a testing convenience safe to ship. An
     * approval nobody is told about is an approval nobody answers, and the tool
     * call waiting on it simply stops — so the switch is honoured outside
     * production and ignored inside it.
     */
    assert.equal(
      resolveApprovalGateOptions(production({ DIVO_APPROVAL_CARDS_ENABLED: false }))
        .suppressCardDelivery,
      false,
    );
    assert.equal(
      resolveApprovalGateOptions({
        NODE_ENV: 'development',
        DIVO_APPROVAL_DISABLE_MANAGER_SELF_BYPASS: false,
        DIVO_HITL_TEST_DISABLE_MANAGER_SELF_BYPASS: false,
        DIVO_APPROVAL_CARDS_ENABLED: false,
      }).suppressCardDelivery,
      true,
    );
    // Absent reads as "send them", never as silence.
    assert.equal(
      resolveApprovalGateOptions({
        NODE_ENV: 'development',
        DIVO_APPROVAL_DISABLE_MANAGER_SELF_BYPASS: false,
        DIVO_HITL_TEST_DISABLE_MANAGER_SELF_BYPASS: false,
      }).suppressCardDelivery,
      false,
    );
  });

  it('fails startup for incomplete, insecure legacy Shopify OAuth or non-encrypting production configuration', () => {
    const issues = validateProductionEnv(production({
      SHOPIFY_CLIENT_ID: undefined,
      SHOPIFY_CLIENT_SECRET: undefined,
      SHOPIFY_REDIRECT_URI: 'http://127.0.0.1:3000/api/shopify/auth/callback',
      INTEGRATION_TOKEN_ENCRYPTION_KEY: 'short',
    }));
    assert.ok(issues.some(issue => issue.includes('SHOPIFY_CLIENT_ID is required when legacy Shopify OAuth is configured')));
    assert.ok(issues.some(issue => issue.includes('SHOPIFY_CLIENT_SECRET is required when legacy Shopify OAuth is configured')));
    assert.ok(issues.some(issue => issue.includes('SHOPIFY_REDIRECT_URI must use HTTPS')));
    assert.ok(issues.some(issue => issue.includes('INTEGRATION_TOKEN_ENCRYPTION_KEY')));
  });

  it('does not require legacy Shopify OAuth when stores use per-store credentials', () => {
    assert.deepEqual(validateProductionEnv(production({
      SHOPIFY_CLIENT_ID: undefined,
      SHOPIFY_CLIENT_SECRET: undefined,
      SHOPIFY_REDIRECT_URI: undefined,
    })), []);
  });

  it('allows protected Shopify tools only with their exact provider scopes', () => {
    assert.deepEqual(validateProductionEnv(production({
      SHOPIFY_PROTECTED_DATA_TOOLS_ENABLED: true,
      SHOPIFY_SCOPES: 'read_reports,read_orders,read_customers',
    })), []);

    const missing = validateProductionEnv(production({
      SHOPIFY_PROTECTED_DATA_TOOLS_ENABLED: true,
      SHOPIFY_SCOPES: 'read_reports,read_orders',
    }));
    assert.ok(missing.some(issue => issue.includes('must include read_customers')));

    const overScoped = validateProductionEnv(production({
      SHOPIFY_PROTECTED_DATA_TOOLS_ENABLED: false,
      SHOPIFY_SCOPES: 'read_reports,read_orders,read_customers',
    }));
    assert.ok(overScoped.some(issue => issue.includes('SHOPIFY_SCOPES must not request')));

    const writeScoped = validateProductionEnv(production({
      SHOPIFY_PROTECTED_DATA_TOOLS_ENABLED: true,
      SHOPIFY_SCOPES: 'read_reports,read_orders,read_customers,write_orders',
    }));
    assert.ok(writeScoped.some(issue => issue.includes('unsupported scope write_orders')));
  });
});
