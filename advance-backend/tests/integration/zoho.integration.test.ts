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

import { ZohoBooksClient }    from '../../src/infrastructure/zoho/zoho-books.client.ts';
import { ZohoCrmClient }      from '../../src/infrastructure/zoho/zoho-crm.client.ts';
import { createZohoBooksTool } from '../../src/application/tools/families/zoho-books.tool.ts';
import { createZohoCrmTool }   from '../../src/application/tools/families/zoho-crm.tool.ts';

const ZOHO_ACCESS_TOKEN = process.env['ZOHO_ACCESS_TOKEN'];
const ZOHO_ORG_ID       = process.env['ZOHO_ORG_ID'];
const missingZoho       = !ZOHO_ACCESS_TOKEN || !ZOHO_ORG_ID;
const crmWriteEnabled   = process.env['ZOHO_CRM_TEST_WRITE'] === '1';

// ─── Minimal ZohoFinanceOps stub (used only for build_overdue_report) ─────────

const stubFinanceOps = {
  buildOverdueReport: async () => {
    throw new Error('build_overdue_report not tested in integration suite');
  },
};

// ─── zohoBooks ────────────────────────────────────────────────────────────────

describe('zohoBooks — integration', { skip: missingZoho ? 'ZOHO_ACCESS_TOKEN / ZOHO_ORG_ID not set' : false }, () => {
  const getClient = async (_companyId: string, _userId: string) =>
    new ZohoBooksClient(ZOHO_ACCESS_TOKEN!, ZOHO_ORG_ID!);

  const tool = createZohoBooksTool({
    getClient,
    financeOps: stubFinanceOps as any,
  });

  const ctx = makeIntCtx('zohoBooks', { companyId: ZOHO_ORG_ID });

  it('list_invoices: returns invoice list (may be empty)', async () => {
    const r = await tool.execute({ op: 'list_invoices', limit: 10 }, ctx);
    assert.equal(r.ok, true, `list_invoices failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    const data = (r as any).value.data;
    assert.ok(Array.isArray(data), 'data should be an array');
    noopLogger.info('zohoBooks.list_invoices', { count: data.length });
  });

  it('get_invoice: reads a specific invoice if any exist', async () => {
    // First list to get an actual invoice ID
    const list = await tool.execute({ op: 'list_invoices', limit: 1 }, ctx);
    if (!list.ok) { return; }
    const invoices = (list as any).value.data as Array<{ invoice_id?: string }>;
    if (invoices.length === 0) {
      noopLogger.info('zohoBooks.get_invoice', { skipped: 'no invoices found' });
      return;
    }
    const invoiceId = invoices[0]?.invoice_id ?? (invoices[0] as any)?.id;
    assert.ok(invoiceId, 'invoice should have an ID');

    const r = await tool.execute({ op: 'get_invoice', invoiceId }, ctx);
    assert.equal(r.ok, true, `get_invoice failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok((r as any).value.data, 'should return invoice data');
  });

  it('list_contacts: returns contact list (may be empty)', async () => {
    const r = await tool.execute({ op: 'list_contacts', limit: 10 }, ctx);
    assert.equal(r.ok, true, `list_contacts failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok(Array.isArray((r as any).value.data));
  });

  it('get_contact: reads a specific contact if any exist', async () => {
    const list = await tool.execute({ op: 'list_contacts', limit: 1 }, ctx);
    if (!list.ok) { return; }
    const contacts = (list as any).value.data as Array<{ contact_id?: string }>;
    if (contacts.length === 0) {
      noopLogger.info('zohoBooks.get_contact', { skipped: 'no contacts found' });
      return;
    }
    const contactId = contacts[0]?.contact_id ?? (contacts[0] as any)?.id;
    assert.ok(contactId);

    const r = await tool.execute({ op: 'get_contact', contactId }, ctx);
    assert.equal(r.ok, true, `get_contact failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok((r as any).value.data);
  });

  it('list_expenses: returns expense list (may be empty)', async () => {
    const r = await tool.execute({ op: 'list_expenses', limit: 10 }, ctx);
    assert.equal(r.ok, true, `list_expenses failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok(Array.isArray((r as any).value.data));
  });
});

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
