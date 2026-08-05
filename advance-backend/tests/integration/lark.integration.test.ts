/**
 * Lark integration tests — real API calls.
 *
 * Required env vars (suite is skipped when absent):
 *   LARK_APP_ID      — Lark app ID
 *   LARK_APP_SECRET  — Lark app secret
 *
 * Optional env vars:
 *   LARK_CALENDAR_ID — Lark calendar ID (defaults to "primary")
 *   LARK_CHAT_ID     — Chat ID for larkMessaging list test (skipped when absent)
 *   LARK_BASE_APP_TOKEN  — Lark Base app token for larkBase list test
 *   LARK_BASE_TABLE_ID   — Lark Base table ID for larkBase list test
 *
 * Tests exercise each tool the exact way the supervisor agent calls them:
 *   tool.execute(args, ctx) → Result<T, ToolError>
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeIntCtx, noopPeopleResolver, futureISO } from './helpers/int.helpers.ts';

import { LarkTaskClient }          from '../../src/infrastructure/channels/lark/clients/lark-task.client.ts';
import { LarkCalendarClient }      from '../../src/infrastructure/channels/lark/clients/lark-calendar.client.ts';
import { LarkDocClient }           from '../../src/infrastructure/channels/lark/clients/lark-doc.client.ts';
import { LarkToolMessagingClient } from '../../src/infrastructure/channels/lark/clients/lark-messaging.client.ts';
import { LarkBaseClient }          from '../../src/infrastructure/channels/lark/clients/lark-base.client.ts';

import { createLarkTaskTool }      from '../../src/application/tools/families/lark-task.tool.ts';
import { createLarkCalendarTool }  from '../../src/application/tools/families/lark-calendar.tool.ts';
import { createLarkDocTool }       from '../../src/application/tools/families/lark-doc.tool.ts';
import { createLarkMessagingTool } from '../../src/application/tools/families/lark-messaging.tool.ts';
import { createLarkBaseTool }      from '../../src/application/tools/families/lark-base.tool.ts';

const LARK_APP_ID     = process.env['LARK_APP_ID'];
const LARK_APP_SECRET = process.env['LARK_APP_SECRET'];
const missingLark     = !LARK_APP_ID || !LARK_APP_SECRET;

// ─── larkTask ─────────────────────────────────────────────────────────────────

describe('larkTask — integration', { skip: missingLark ? 'LARK_APP_ID / LARK_APP_SECRET not set' : false }, () => {
  const client = new LarkTaskClient({ appId: LARK_APP_ID!, appSecret: LARK_APP_SECRET! });
  const tool   = createLarkTaskTool({ client, peopleResolver: noopPeopleResolver });
  const ctx    = makeIntCtx('larkTask');

  let createdTaskId: string | undefined;

  after(async () => {
    if (createdTaskId) {
      await client.deleteTask(createdTaskId).catch(() => {});
    }
  });

  it('create: creates a real Lark task (safe-to-delete marker in title)', async () => {
    const r = await tool.execute({
      op:    'create',
      title: '[DIVO-INT-TEST] Integration test task — safe to delete',
    }, ctx);
    assert.equal(r.ok, true, `create failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    createdTaskId = (r as any).value.taskId as string;
    assert.ok(createdTaskId, 'create should return a taskId');
  });

  it('list: returns the current identity\'s visible task page', async (t) => {
    if (!createdTaskId) { t.skip('create did not produce a taskId'); return; }
    const r = await tool.execute({ op: 'list', limit: 50 }, ctx);
    assert.equal(r.ok, true);
    const tasks = (r as any).value.data as Array<{ taskId: string; title: string }>;
    assert.ok(Array.isArray(tasks), 'data should be an array');
    for (const task of tasks) {
      assert.equal(typeof task.taskId, 'string');
      assert.equal(typeof task.title, 'string');
    }
  });

  it('get: fetches the created task by ID', async (t) => {
    if (!createdTaskId) { t.skip('create did not produce a taskId'); return; }
    const r = await tool.execute({ op: 'get', taskId: createdTaskId }, ctx);
    assert.equal(r.ok, true);
    const task = (r as any).value.data as { taskId: string; title: string };
    assert.equal(task.taskId, createdTaskId);
    assert.ok(task.title.includes('[DIVO-INT-TEST]'));
  });

  it('update: renames the task', async (t) => {
    if (!createdTaskId) { t.skip('create did not produce a taskId'); return; }
    const r = await tool.execute({
      op:     'update',
      taskId: createdTaskId,
      title:  '[DIVO-INT-TEST] Integration test task — renamed',
      notes:  'Updated by integration test',
    }, ctx);
    assert.equal(r.ok, true);
    assert.equal((r as any).value.success, true);
  });

  it('complete: marks the task done', async (t) => {
    if (!createdTaskId) { t.skip('create did not produce a taskId'); return; }
    const r = await tool.execute({ op: 'complete', taskId: createdTaskId }, ctx);
    assert.equal(r.ok, true);
    assert.equal((r as any).value.success, true);
  });

  it('delete: removes the task', async (t) => {
    if (!createdTaskId) { t.skip('create did not produce a taskId'); return; }
    const r = await tool.execute({ op: 'delete', taskId: createdTaskId }, ctx);
    assert.equal(r.ok, true);
    createdTaskId = undefined; // prevent double-delete in after()
  });
});

// ─── larkCalendar ─────────────────────────────────────────────────────────────

describe('larkCalendar — integration', { skip: missingLark ? 'LARK_APP_ID / LARK_APP_SECRET not set' : false }, () => {
  const calendarId = process.env['LARK_CALENDAR_ID'] ?? 'primary';
  const client     = new LarkCalendarClient({ appId: LARK_APP_ID!, appSecret: LARK_APP_SECRET! });
  const tool       = createLarkCalendarTool({ client });
  const ctx        = makeIntCtx('larkCalendar');

  let createdEventId: string | undefined;

  after(async () => {
    if (createdEventId) {
      await client.deleteEvent(calendarId, createdEventId).catch(() => {});
    }
  });

  it('list: returns current events (may be empty)', async () => {
    const r = await tool.execute({ op: 'list', calendarId, limit: 10 }, ctx);
    assert.equal(r.ok, true, `list failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok(Array.isArray((r as any).value.data));
  });

  it('create: creates a calendar event one hour from now', async () => {
    const r = await tool.execute({
      op:          'create',
      calendarId,
      title:       '[DIVO-INT-TEST] Integration test event — safe to delete',
      description: 'Created by advance-backend integration test',
      startTime:   futureISO(60),
      endTime:     futureISO(90),
    }, ctx);
    assert.equal(r.ok, true, `create failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    createdEventId = (r as any).value.eventId as string;
    assert.ok(createdEventId, 'create should return an eventId');
  });

  it('get: fetches the created event by ID', async (t) => {
    if (!createdEventId) { t.skip('create did not produce an eventId'); return; }
    const r = await tool.execute({ op: 'get', calendarId, eventId: createdEventId }, ctx);
    assert.equal(r.ok, true);
    assert.ok((r as any).value.data, 'should return event data');
  });

  it('update: changes the event title', async (t) => {
    if (!createdEventId) { t.skip('create did not produce an eventId'); return; }
    const r = await tool.execute({
      op:        'update',
      calendarId,
      eventId:   createdEventId,
      title:     '[DIVO-INT-TEST] Integration test event — updated',
      startTime: futureISO(60),
      endTime:   futureISO(90),
    }, ctx);
    assert.equal(r.ok, true);
  });

  it('delete: removes the event', async (t) => {
    if (!createdEventId) { t.skip('create did not produce an eventId'); return; }
    const r = await tool.execute({ op: 'delete', calendarId, eventId: createdEventId }, ctx);
    assert.equal(r.ok, true);
    createdEventId = undefined;
  });
});

// ─── larkDoc ─────────────────────────────────────────────────────────────────

describe('larkDoc — integration', { skip: missingLark ? 'LARK_APP_ID / LARK_APP_SECRET not set' : false }, () => {
  const client = new LarkDocClient({ appId: LARK_APP_ID!, appSecret: LARK_APP_SECRET! });
  const tool   = createLarkDocTool({ client });
  const ctx    = makeIntCtx('larkDoc');

  let createdDocToken: string | undefined;

  it('create: creates a new Lark Doc', async () => {
    const r = await tool.execute({
      op:    'create',
      title: '[DIVO-INT-TEST] Integration test doc — safe to delete',
    }, ctx);
    assert.equal(r.ok, true, `create failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    createdDocToken = (r as any).value.docToken as string;
    assert.ok(createdDocToken, 'create should return a docToken');
  });

  it('get: reads the created doc', async (t) => {
    if (!createdDocToken) { t.skip('create did not produce a docToken'); return; }
    const r = await tool.execute({ op: 'get', docToken: createdDocToken }, ctx);
    assert.equal(r.ok, true);
    assert.ok((r as any).value.data, 'should return doc data');
  });

  it('append_block: appends a paragraph to the doc', async (t) => {
    if (!createdDocToken) { t.skip('create did not produce a docToken'); return; }
    const r = await tool.execute({
      op:       'append_block',
      docToken: createdDocToken,
      content:  'Integration test paragraph — written by advance-backend tests.',
    }, ctx);
    assert.equal(r.ok, true);
  });

  it('list_blocks: lists blocks in the doc', async (t) => {
    if (!createdDocToken) { t.skip('create did not produce a docToken'); return; }
    const r = await tool.execute({ op: 'list_blocks', docToken: createdDocToken }, ctx);
    assert.equal(r.ok, true);
    assert.ok(Array.isArray((r as any).value.data));
  });
});

// ─── larkMessaging (read-only, requires a chat ID) ────────────────────────────

describe('larkMessaging — integration', { skip: !process.env['LARK_CHAT_ID'] || missingLark ? 'LARK_CHAT_ID or Lark creds not set' : false }, () => {
  const chatId = process.env['LARK_CHAT_ID']!;
  const client = new LarkToolMessagingClient({ appId: LARK_APP_ID!, appSecret: LARK_APP_SECRET! });
  const tool   = createLarkMessagingTool({ client });
  const ctx    = makeIntCtx('larkMessaging');

  it('list: returns recent messages in the chat', async () => {
    const r = await tool.execute({ op: 'list', chatId, limit: 10 }, ctx);
    assert.equal(r.ok, true, `list failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok(Array.isArray((r as any).value.data));
  });

  it('send: sends a test message', async () => {
    const r = await tool.execute({
      op:     'send',
      chatId,
      text:   '[DIVO-INT-TEST] Integration test message — sent by advance-backend tests.',
    }, ctx);
    assert.equal(r.ok, true, `send failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok((r as any).value.messageId as string);
  });
});

// ─── larkBase (read-only, requires an app token + table ID) ──────────────────

describe('larkBase — integration', {
  skip: (!process.env['LARK_BASE_APP_TOKEN'] || !process.env['LARK_BASE_TABLE_ID'] || missingLark)
    ? 'LARK_BASE_APP_TOKEN / LARK_BASE_TABLE_ID / Lark creds not set'
    : false,
}, () => {
  const appToken = process.env['LARK_BASE_APP_TOKEN']!;
  const tableId  = process.env['LARK_BASE_TABLE_ID']!;
  const client   = new LarkBaseClient({ appId: LARK_APP_ID!, appSecret: LARK_APP_SECRET! });
  const tool     = createLarkBaseTool({ client });
  const ctx      = makeIntCtx('larkBase');

  let createdRecordId: string | undefined;

  after(async () => {
    if (createdRecordId) {
      await client.deleteRecord(appToken, tableId, createdRecordId).catch(() => {});
    }
  });

  it('list_records: reads existing records', async () => {
    const r = await tool.execute({ op: 'list_records', appToken, tableId, limit: 5 }, ctx);
    assert.equal(r.ok, true, `list_records failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok(Array.isArray((r as any).value.data));
  });

  it('create_record: creates a test record', async () => {
    const r = await tool.execute({
      op:       'create_record',
      appToken,
      tableId,
      fields:   { Name: '[DIVO-INT-TEST] Integration test record — safe to delete' },
    }, ctx);
    assert.equal(r.ok, true, `create_record failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    createdRecordId = (r as any).value.recordId as string;
    assert.ok(createdRecordId);
  });

  it('get_record: reads the created record', async (t) => {
    if (!createdRecordId) { t.skip('create_record did not produce a recordId'); return; }
    const r = await tool.execute({ op: 'get_record', appToken, tableId, recordId: createdRecordId }, ctx);
    assert.equal(r.ok, true);
    assert.ok((r as any).value.data);
  });

  it('delete_record: removes the record', async (t) => {
    if (!createdRecordId) { t.skip('create_record did not produce a recordId'); return; }
    const r = await tool.execute({ op: 'delete_record', appToken, tableId, recordId: createdRecordId }, ctx);
    assert.equal(r.ok, true);
    createdRecordId = undefined;
  });
});
