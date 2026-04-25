#!/usr/bin/env tsx
/**
 * test-lark-tools.ts — smoke-test every Lark API client against the real API.
 *
 * Usage:
 *   pnpm tsx scripts/test-lark-tools.ts [options]
 *
 * Auto-resolve mode (recommended):
 *   pnpm tsx scripts/test-lark-tools.ts --company-id <uuid>
 *     Looks up the user access token and a recent chat ID from the database.
 *     Unlocks: messaging tests + task list.
 *
 * Manual options (override or supplement auto-resolve):
 *   --chat-id <id>          Lark chat ID for messaging tests
 *   --calendar-id <id>      Lark calendar ID (default: primary)
 *   --approval-code <id>    Lark approval code for approval list test
 *   --base-app-token <id>   Lark Base app token
 *   --base-table-id <id>    Lark Base table ID
 *   --fields <json>         JSON fields for Base record create (default: {"name":"Divo Test"})
 */

import 'dotenv/config';
import { createDecipheriv, createHash } from 'node:crypto';
import { LarkTaskClient }              from '../src/infrastructure/channels/lark/clients/lark-task.client';
import { LarkCalendarClient }          from '../src/infrastructure/channels/lark/clients/lark-calendar.client';
import { LarkDocClient }               from '../src/infrastructure/channels/lark/clients/lark-doc.client';
import { LarkBaseClient }              from '../src/infrastructure/channels/lark/clients/lark-base.client';
import { LarkApprovalClient }          from '../src/infrastructure/channels/lark/clients/lark-approval.client';
import { LarkToolMessagingClient }     from '../src/infrastructure/channels/lark/clients/lark-messaging.client';
import { getPrismaClient, disconnectPrisma } from '../src/infrastructure/persistence/prisma.client';

// ── CLI args ──────────────────────────────────────────────────────────────────

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const COMPANY_ID    = arg('--company-id');
const CALENDAR_ID   = arg('--calendar-id') ?? 'primary';
const APPROVAL_CODE = arg('--approval-code');
const BASE_APP      = arg('--base-app-token');
const BASE_TABLE    = arg('--base-table-id');
const BASE_FIELDS   = (() => {
  const raw = arg('--fields');
  if (!raw) return { name: 'Divo Test' };
  try { return JSON.parse(raw) as Record<string, unknown>; }
  catch { console.error('--fields must be valid JSON'); process.exit(1); }
})();

// ── Credentials ───────────────────────────────────────────────────────────────

const appId     = process.env['LARK_APP_ID'];
const appSecret = process.env['LARK_APP_SECRET'];
if (!appId || !appSecret) {
  console.error('LARK_APP_ID and LARK_APP_SECRET must be set in .env');
  process.exit(1);
}
const tenantCreds = { appId, appSecret };

// ── Colours & result tracking ─────────────────────────────────────────────────

const G = '\x1b[32m'; const R = '\x1b[31m'; const Y = '\x1b[33m';
const C = '\x1b[36m'; const D = '\x1b[2m';  const N = '\x1b[0m';

let passed = 0; let failed = 0; let skipped = 0;

function pass(label: string, note = '')       { passed++;  console.log(`  ${G}✓${N}  ${label.padEnd(28)} ${D}${note}${N}`); }
function fail(label: string, e: unknown)      { failed++;  console.log(`  ${R}✗${N}  ${label.padEnd(28)} ${R}${e instanceof Error ? e.message : String(e)}${N}`); }
function skip(label: string, reason: string)  { skipped++; console.log(`  ${Y}⚠${N}  ${label.padEnd(28)} ${D}skipped — ${reason}${N}`); }
function section(title: string)               { console.log(`\n${C}── ${title} ${'─'.repeat(Math.max(0, 44 - title.length))}${N}`); }

const TS = new Date().toISOString().slice(0, 19).replace('T', ' ');

// ── DB context resolution ─────────────────────────────────────────────────────

function decryptToken(cipherText: string, encryptionKey: string): string {
  const toBuffer = (s: string) => s.startsWith('base64:')
    ? Buffer.from(s.slice(7), 'base64')
    : createHash('sha256').update(s).digest();
  const parts = cipherText.trim().split(':');
  if (parts.length !== 4) throw new Error('Unexpected encrypted format (expected v:iv:tag:data)');
  const key = toBuffer(encryptionKey);
  const iv  = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const enc = Buffer.from(parts[3]!, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

interface DbContext {
  userToken?: string;
  chatId?: string;
  larkEmail?: string;
}

async function resolveDbContext(companyId: string): Promise<DbContext> {
  const encKey = process.env['ZOHO_TOKEN_ENCRYPTION_KEY'];
  if (!encKey) {
    console.log(`  ${D}ZOHO_TOKEN_ENCRYPTION_KEY not set — skipping DB token lookup${N}`);
    return {};
  }

  const prisma = getPrismaClient();
  const ctx: DbContext = {};

  // User access token — most recent non-revoked link
  try {
    const link = await (prisma as any).larkUserAuthLink.findFirst({
      where: { companyId, revokedAt: null },
      orderBy: [{ lastUsedAt: 'desc' }, { updatedAt: 'desc' }],
      select: { accessTokenEncrypted: true, accessTokenExpiresAt: true, larkEmail: true },
    });
    if (link?.accessTokenEncrypted) {
      const token = decryptToken(link.accessTokenEncrypted, encKey);
      const expiry = link.accessTokenExpiresAt ? new Date(link.accessTokenExpiresAt) : null;
      const expired = expiry && expiry < new Date();
      if (!expired) {
        ctx.userToken = token;
        ctx.larkEmail = link.larkEmail ?? undefined;
      } else {
        console.log(`  ${D}User token expired at ${expiry?.toISOString()} — task list will still be skipped${N}`);
      }
    }
  } catch (e) {
    console.log(`  ${D}User token lookup failed: ${e instanceof Error ? e.message : String(e)}${N}`);
  }

  // Chat ID — prefer group chats (oc_ prefix) as they work with receive_id_type=chat_id.
  // p2p chats use open_id (ou_ prefix) which the messaging client doesn't support yet.
  try {
    const chatCtxs = await (prisma as any).larkChatContext.findMany({
      where: { companyId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      select: { chatId: true, chatType: true },
    });
    const group = (chatCtxs as Array<{ chatId: string; chatType: string | null }>)
      .find(c => c.chatId.startsWith('oc_') || c.chatType === 'group');
    const any = (chatCtxs as Array<{ chatId: string }>)[0];
    if (group) ctx.chatId = group.chatId;
    else if (any) ctx.chatId = any.chatId;
  } catch (e) {
    console.log(`  ${D}Chat ID lookup failed: ${e instanceof Error ? e.message : String(e)}${N}`);
  }

  return ctx;
}

// ── Test suites ───────────────────────────────────────────────────────────────

async function testTasks(userToken?: string) {
  section('Tasks');
  const client = new LarkTaskClient(tenantCreds);
  let taskId: string | undefined;

  try {
    const r = await client.createTask({
      title: `[Divo Test] ${TS}`,
      dueDate: new Date(Date.now() + 86_400_000).toISOString(),
    });
    taskId = r.taskId;
    pass('create task', `taskId: ${taskId}`);
  } catch (e) { fail('create task', e); }

  if (!taskId) {
    ['get task', 'update task', 'complete task', 'delete task'].forEach(l => skip(l, 'create failed'));
  } else {
    try {
      const r = await client.getTask(taskId);
      pass('get task', `title: ${r.title}`);
    } catch (e) { fail('get task', e); }

    try {
      await client.updateTask(taskId, { title: `[Divo Test] ${TS} (updated)`, notes: 'Automated test' });
      pass('update task');
    } catch (e) { fail('update task', e); }

    try {
      await client.completeTask(taskId);
      pass('complete task');
    } catch (e) { fail('complete task', e); }

    try {
      await client.deleteTask(taskId);
      pass('delete task');
    } catch (e) { fail('delete task', e); }
  }

  // list — requires user token
  if (userToken) {
    try {
      const userClient = new LarkTaskClient({ appId, appSecret, userToken });
      const items = await userClient.listTasks({ limit: 20 });
      pass('list tasks', `${items.length} returned`);
    } catch (e) { fail('list tasks', e); }
  } else {
    skip('list tasks', 'pass --company-id to auto-resolve user token');
  }
}

async function testMessaging(chatId: string | undefined) {
  section('Messaging');
  if (!chatId) {
    ['send message', 'list messages', 'get message', 'reply message']
      .forEach(l => skip(l, 'pass --chat-id or --company-id to enable'));
    return;
  }

  const client = new LarkToolMessagingClient(tenantCreds);
  let messageId: string | undefined;

  try {
    const r = await client.sendMessage(chatId, `[Divo Test] ${TS} — automated tool smoke test`);
    messageId = r.messageId;
    pass('send message', `messageId: ${messageId}`);
  } catch (e) { fail('send message', e); }

  try {
    const items = await client.listMessages(chatId, 20);
    pass('list messages', `${items.length} returned`);
  } catch (e) { fail('list messages', e); }

  if (messageId) {
    try {
      const r = await client.getMessage(messageId);
      pass('get message', `senderId: ${r.senderId}`);
    } catch (e) { fail('get message', e); }

    try {
      await client.replyMessage(messageId, `[Divo Test] reply to ${messageId}`);
      pass('reply message');
    } catch (e) { fail('reply message', e); }
  } else {
    ['get message', 'reply message'].forEach(l => skip(l, 'send failed'));
  }
}

async function testCalendar() {
  section(`Calendar  (id: ${CALENDAR_ID})`);
  const client = new LarkCalendarClient(tenantCreds);
  let eventId: string | undefined;

  try {
    const items = await client.listEvents(CALENDAR_ID, 50) as unknown[];
    pass('list events', `${items.length} returned`);
  } catch (e) { fail('list events', e); }

  const start = new Date(Date.now() + 86_400_000);
  const end   = new Date(start.getTime() + 3_600_000);
  try {
    const r = await client.createEvent(CALENDAR_ID, {
      title: `[Divo Test] ${TS}`,
      startTime: start.toISOString(),
      endTime:   end.toISOString(),
      description: 'Automated tool smoke test',
    });
    eventId = r.eventId;
    pass('create event', `eventId: ${eventId}`);
  } catch (e) { fail('create event', e); }

  if (!eventId) {
    ['get event', 'update event', 'delete event'].forEach(l => skip(l, 'create failed'));
    return;
  }

  try {
    const r = await client.getEvent(CALENDAR_ID, eventId) as Record<string, unknown>;
    pass('get event', `summary: ${r['summary']}`);
  } catch (e) { fail('get event', e); }

  try {
    await client.updateEvent(CALENDAR_ID, eventId, { summary: `[Divo Test] ${TS} (updated)` });
    pass('update event');
  } catch (e) { fail('update event', e); }

  try {
    await client.deleteEvent(CALENDAR_ID, eventId);
    pass('delete event');
  } catch (e) { fail('delete event', e); }
}

async function testDocs() {
  section('Docs');
  const client = new LarkDocClient(tenantCreds);
  let docToken: string | undefined;

  try {
    const r = await client.createDoc(`[Divo Test] ${TS}`);
    docToken = r.docToken;
    pass('create doc', `docToken: ${docToken}`);
  } catch (e) { fail('create doc', e); }

  if (!docToken) {
    ['get doc', 'append block', 'list blocks'].forEach(l => skip(l, 'create failed'));
    return;
  }

  try {
    const r = await client.getDoc(docToken) as Record<string, unknown>;
    pass('get doc', `title: ${r['title']}`);
  } catch (e) { fail('get doc', e); }

  try {
    await client.appendBlock(docToken, `Automated test content — ${TS}`, 'text');
    pass('append block');
  } catch (e) { fail('append block', e); }

  try {
    const blocks = await client.listBlocks(docToken);
    pass('list blocks', `${blocks.length} blocks`);
  } catch (e) { fail('list blocks', e); }
}

async function testBase() {
  section('Base (multi-dim table)');
  if (!BASE_APP || !BASE_TABLE) {
    ['list records', 'create record', 'get record', 'update record', 'delete record', 'search records']
      .forEach(l => skip(l, 'pass --base-app-token and --base-table-id to enable'));
    return;
  }

  const client = new LarkBaseClient(tenantCreds);
  let recordId: string | undefined;

  try {
    const items = await client.listRecords(BASE_APP, BASE_TABLE, 20);
    pass('list records', `${items.length} returned`);
  } catch (e) { fail('list records', e); }

  try {
    const r = await client.createRecord(BASE_APP, BASE_TABLE, BASE_FIELDS);
    recordId = r.recordId;
    pass('create record', `recordId: ${recordId}`);
  } catch (e) { fail('create record', e); }

  if (!recordId) {
    ['get record', 'update record', 'delete record'].forEach(l => skip(l, 'create failed'));
  } else {
    try {
      await client.getRecord(BASE_APP, BASE_TABLE, recordId);
      pass('get record');
    } catch (e) { fail('get record', e); }

    try {
      await client.updateRecord(BASE_APP, BASE_TABLE, recordId, { ...BASE_FIELDS, _updated: TS });
      pass('update record');
    } catch (e) { fail('update record', e); }

    try {
      await client.deleteRecord(BASE_APP, BASE_TABLE, recordId);
      pass('delete record');
    } catch (e) { fail('delete record', e); }
  }

  try {
    const items = await client.searchRecords(BASE_APP, BASE_TABLE, 'Divo', 20);
    pass('search records', `${items.length} returned`);
  } catch (e) { fail('search records', e); }
}

async function testApproval() {
  section('Approval');
  if (!APPROVAL_CODE) {
    ['list instances', 'get instance'].forEach(l => skip(l, 'pass --approval-code to enable'));
    return;
  }

  const client = new LarkApprovalClient(tenantCreds);

  try {
    const items = await client.listInstances(APPROVAL_CODE, 20) as unknown[];
    pass('list instances', `${items.length} returned`);

    if (items.length > 0) {
      const first = items[0] as Record<string, unknown>;
      const instanceCode = first['instanceCode'] as string | undefined;
      if (instanceCode) {
        try {
          await client.getInstance(APPROVAL_CODE, instanceCode);
          pass('get instance', `instanceCode: ${instanceCode}`);
        } catch (e) { fail('get instance', e); }
      } else {
        skip('get instance', 'no instanceCode in first result');
      }
    } else {
      skip('get instance', 'no instances to fetch');
    }
  } catch (e) {
    fail('list instances', e);
    skip('get instance', 'list failed');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

void (async () => {
  console.log(`\n${C}Divo — Lark tool smoke test${N}  ${D}${TS}${N}`);
  console.log(`${D}App ID: ${appId}${N}`);

  // Resolve DB context if company-id given
  let dbCtx: DbContext = {};
  if (COMPANY_ID) {
    console.log(`${D}Resolving context for company: ${COMPANY_ID}${N}`);
    dbCtx = await resolveDbContext(COMPANY_ID);
    if (dbCtx.userToken) console.log(`${D}User token: resolved (${dbCtx.larkEmail ?? 'unknown email'})${N}`);
    if (dbCtx.chatId)    console.log(`${D}Chat ID:    ${dbCtx.chatId}${N}`);
  }

  // CLI args override DB-resolved values
  const chatId = arg('--chat-id') ?? dbCtx.chatId;

  await testTasks(dbCtx.userToken);
  await testMessaging(chatId);
  await testCalendar();
  await testDocs();
  await testBase();
  await testApproval();

  await disconnectPrisma();

  const statusColor = failed > 0 ? R : G;
  console.log(
    `\n${statusColor}Summary:${N} ${G}${passed} passed${N} · ${R}${failed} failed${N} · ${Y}${skipped} skipped${N}\n`,
  );
  process.exit(failed > 0 ? 1 : 0);
})();
