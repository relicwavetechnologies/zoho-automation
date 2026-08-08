/**
 * Zoho integration tests — real API calls.
 *
 * Required env vars (suite is skipped when absent):
 *   ZOHO_ACCESS_TOKEN — valid Zoho OAuth access token
 *   ZOHO_ORG_ID       — Zoho Books organization ID (numeric string)
 *
 * Optional env vars:
 *   ZOHO_CRM_TEST_WRITE=1 — enables CRM create/update/delete tests
 *                           (defaults to read-only to avoid polluting production data)
 *
 * Tests exercise each tool the exact way the supervisor agent calls them:
 *   tool.execute(args, ctx) → Result<T, ToolError>
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeIntCtx, noopLogger } from './helpers/int.helpers.ts';

import { ZohoCrmClient }      from '../../src/infrastructure/zoho/zoho-crm.client.ts';
import { createZohoCrmTool }   from '../../src/application/tools/families/zoho-crm.tool.ts';

const ZOHO_ACCESS_TOKEN = process.env['ZOHO_ACCESS_TOKEN'];
const ZOHO_ORG_ID       = process.env['ZOHO_ORG_ID'];
const missingZoho       = !ZOHO_ACCESS_TOKEN || !ZOHO_ORG_ID;
const crmWriteEnabled   = process.env['ZOHO_CRM_TEST_WRITE'] === '1';

// zohoBooks is no longer reachable from a bare access token: reads and writes
// both run through ZohoBooksPaginatedClient, which resolves auth per connection
// through ZohoTokenService. Its live coverage belongs in a suite that can build
// that, not here.

// ─── zohoCrm ─────────────────────────────────────────────────────────────────

describe('zohoCrm — integration', { skip: missingZoho ? 'ZOHO_ACCESS_TOKEN not set' : false }, () => {
  const getClient = async (_companyId: string, _userId: string) =>
    new ZohoCrmClient(ZOHO_ACCESS_TOKEN!);

  const tool = createZohoCrmTool({ getClient });
  const ctx  = makeIntCtx('zohoCrm');

  let createdContactId: string | undefined;

  after(async () => {
    if (createdContactId) {
      // Best-effort cleanup — won't throw if CRM delete fails
      await tool.execute({ op: 'delete', module: 'Contacts', recordId: createdContactId }, ctx)
        .catch(() => {});
    }
  });

  it('search: searches Contacts module', async () => {
    const r = await tool.execute({ op: 'search', module: 'Contacts', query: 'test', limit: 5 }, ctx);
    assert.equal(r.ok, true, `search failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok(Array.isArray((r as any).value.data));
  });

  it('search Leads module', async () => {
    const r = await tool.execute({ op: 'search', module: 'Leads', query: 'test', limit: 5 }, ctx);
    assert.equal(r.ok, true, `Leads search failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok(Array.isArray((r as any).value.data));
  });

  it('get: reads first contact if any exist', async () => {
    const list = await tool.execute({ op: 'search', module: 'Contacts', query: '', limit: 1 }, ctx);
    if (!list.ok) { return; }
    const records = (list as any).value.data as Array<{ id?: string }>;
    if (records.length === 0) {
      noopLogger.info('zohoCrm.get', { skipped: 'no contacts found' });
      return;
    }
    const recordId = records[0]?.id ?? '';
    assert.ok(recordId);

    const r = await tool.execute({ op: 'get', module: 'Contacts', recordId }, ctx);
    assert.equal(r.ok, true, `get failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok((r as any).value.data);
  });

  // ── Write tests (opt-in with ZOHO_CRM_TEST_WRITE=1) ───────────────────────

  it('create + update + delete: full contact lifecycle', { skip: !crmWriteEnabled ? 'set ZOHO_CRM_TEST_WRITE=1 to enable' : false }, async () => {
    // create
    const cr = await tool.execute({
      op:     'create',
      module: 'Contacts',
      fields: {
        First_Name: 'DivoIntTest',
        Last_Name:  'AutoDelete',
        Email:      'divo-int-test-autodelete@example.com',
      },
    }, ctx);
    assert.equal(cr.ok, true, `create failed: ${!cr.ok ? JSON.stringify((cr as any).error) : ''}`);
    createdContactId = (cr as any).value.recordId as string;
    assert.ok(createdContactId);

    // update
    const ur = await tool.execute({
      op:       'update',
      module:   'Contacts',
      recordId: createdContactId,
      fields:   { Description: 'Updated by advance-backend integration test' },
    }, ctx);
    assert.equal(ur.ok, true, `update failed: ${!ur.ok ? JSON.stringify((ur as any).error) : ''}`);

    // delete
    const dr = await tool.execute({ op: 'delete', module: 'Contacts', recordId: createdContactId }, ctx);
    assert.equal(dr.ok, true, `delete failed: ${!dr.ok ? JSON.stringify((dr as any).error) : ''}`);
    createdContactId = undefined;
  });
});
