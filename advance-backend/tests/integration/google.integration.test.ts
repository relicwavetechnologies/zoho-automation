/**
 * Google integration tests — real API calls.
 *
 * Required env vars (suite is skipped when absent):
 *   GOOGLE_ACCESS_TOKEN — valid Google OAuth access token
 *                         (get one via the admin panel's "Connect Google" flow,
 *                          or use `gcloud auth print-access-token` for a dev account)
 *
 * Optional env vars:
 *   GOOGLE_TEST_EMAIL   — email address to send test messages to
 *                         (defaults to skipping the send test when absent)
 *   GOOGLE_CALENDAR_ID  — calendar ID for events (defaults to "primary")
 *
 * Tests exercise each tool the exact way the supervisor agent calls them:
 *   tool.execute(args, ctx) → Result<T, ToolError>
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeIntCtx, noopLogger, futureISO } from './helpers/int.helpers.ts';

import { GmailClient }           from '../../src/infrastructure/google/google-gmail.client.ts';
import { GoogleCalendarClient }  from '../../src/infrastructure/google/google-calendar.client.ts';
import { GoogleDriveClient }     from '../../src/infrastructure/google/google-drive.client.ts';
import { createGoogleGmailTool }     from '../../src/application/orchestration/tools/families/google-gmail.tool.ts';
import { createGoogleCalendarTool }  from '../../src/application/orchestration/tools/families/google-calendar.tool.ts';
import { createGoogleDriveTool }     from '../../src/application/orchestration/tools/families/google-drive.tool.ts';

const GOOGLE_ACCESS_TOKEN = process.env['GOOGLE_ACCESS_TOKEN'];
const GOOGLE_TEST_EMAIL   = process.env['GOOGLE_TEST_EMAIL'];
const GOOGLE_CALENDAR_ID  = process.env['GOOGLE_CALENDAR_ID'] ?? 'primary';
const missingGoogle       = !GOOGLE_ACCESS_TOKEN;

// ─── Shared getClient factory ─────────────────────────────────────────────────

const makeGmailClient     = async () => new GmailClient(GOOGLE_ACCESS_TOKEN!);
const makeCalendarClient  = async () => new GoogleCalendarClient(GOOGLE_ACCESS_TOKEN!);
const makeDriveClient     = async () => new GoogleDriveClient(GOOGLE_ACCESS_TOKEN!);

// ─── googleGmail ─────────────────────────────────────────────────────────────

describe('googleGmail — integration', { skip: missingGoogle ? 'GOOGLE_ACCESS_TOKEN not set' : false }, () => {
  const tool = createGoogleGmailTool({ getClient: makeGmailClient });
  const ctx  = makeIntCtx('googleGmail');

  let sentMessageId: string | undefined;

  it('list: returns inbox messages (may be empty)', async () => {
    const r = await tool.execute({ op: 'list', limit: 5 }, ctx);
    assert.equal(r.ok, true, `list failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok(Array.isArray((r as any).value.data));
  });

  it('search: searches for messages with "test" in subject', async () => {
    const r = await tool.execute({ op: 'search', query: 'subject:test', limit: 5 }, ctx);
    assert.equal(r.ok, true, `search failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok(Array.isArray((r as any).value.data));
  });

  it('get: reads the first inbox message if any exist', async () => {
    const list = await tool.execute({ op: 'list', limit: 1 }, ctx);
    if (!list.ok) { return; }
    const msgs = (list as any).value.data as Array<{ messageId: string }>;
    if (msgs.length === 0) {
      noopLogger.info('googleGmail.get', { skipped: 'inbox empty' });
      return;
    }
    const { messageId } = msgs[0]!;

    const r = await tool.execute({ op: 'get', messageId }, ctx);
    assert.equal(r.ok, true, `get failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    const msg = (r as any).value.data as { messageId: string; subject: string; body: string };
    assert.equal(msg.messageId, messageId);
    assert.ok(typeof msg.subject === 'string');
  });

  it('send: sends a test email to GOOGLE_TEST_EMAIL', {
    skip: !GOOGLE_TEST_EMAIL ? 'set GOOGLE_TEST_EMAIL to enable send test' : false,
  }, async () => {
    const r = await tool.execute({
      op:      'send',
      to:      [GOOGLE_TEST_EMAIL!],
      subject: '[DIVO-INT-TEST] Integration test email — safe to delete',
      body:    'This email was sent by the advance-backend integration test suite. Safe to delete.',
    }, ctx);
    assert.equal(r.ok, true, `send failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    sentMessageId = (r as any).value.messageId as string;
    assert.ok(sentMessageId, 'send should return a messageId');
  });

  it('reply: replies to the sent message', {
    skip: !sentMessageId ? 'send test did not run or produce a messageId' : false,
  }, async (t) => {
    if (!sentMessageId) { t.skip('sentMessageId not available'); return; }
    const msgDetail = await (await makeGmailClient()).getMessage(sentMessageId);
    const r = await tool.execute({
      op:       'reply',
      threadId: msgDetail.threadId,
      to:       [GOOGLE_TEST_EMAIL!],
      body:     '[DIVO-INT-TEST] Reply from integration test.',
    }, ctx);
    assert.equal(r.ok, true, `reply failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
  });
});

// ─── googleCalendar ───────────────────────────────────────────────────────────

describe('googleCalendar — integration', { skip: missingGoogle ? 'GOOGLE_ACCESS_TOKEN not set' : false }, () => {
  const tool = createGoogleCalendarTool({ getClient: makeCalendarClient });
  const ctx  = makeIntCtx('googleCalendar');

  let createdEventId: string | undefined;

  after(async () => {
    if (createdEventId) {
      await (await makeCalendarClient())
        .deleteEvent(GOOGLE_CALENDAR_ID, createdEventId)
        .catch(() => {});
    }
  });

  it('list: returns upcoming events (may be empty)', async () => {
    const r = await tool.execute({ op: 'list', calendarId: GOOGLE_CALENDAR_ID, limit: 5 }, ctx);
    assert.equal(r.ok, true, `list failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok(Array.isArray((r as any).value.data));
  });

  it('create: creates an event one hour from now', async () => {
    const r = await tool.execute({
      op:         'create',
      calendarId: GOOGLE_CALENDAR_ID,
      title:      '[DIVO-INT-TEST] Integration test event — safe to delete',
      description: 'Created by advance-backend integration test',
      startTime:  futureISO(60),
      endTime:    futureISO(90),
    }, ctx);
    assert.equal(r.ok, true, `create failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    createdEventId = (r as any).value.eventId as string;
    assert.ok(createdEventId, 'create should return an eventId');
  });

  it('get: reads the created event', async (t) => {
    if (!createdEventId) { t.skip('create did not produce an eventId'); return; }
    const r = await tool.execute({
      op:         'get',
      calendarId: GOOGLE_CALENDAR_ID,
      eventId:    createdEventId,
    }, ctx);
    assert.equal(r.ok, true, `get failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok((r as any).value.data);
  });

  it('update: renames the created event', async (t) => {
    if (!createdEventId) { t.skip('create did not produce an eventId'); return; }
    const r = await tool.execute({
      op:         'update',
      calendarId: GOOGLE_CALENDAR_ID,
      eventId:    createdEventId,
      title:      '[DIVO-INT-TEST] Integration test event — updated',
      startTime:  futureISO(60),
      endTime:    futureISO(90),
    }, ctx);
    assert.equal(r.ok, true, `update failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
  });

  it('delete: removes the event', async (t) => {
    if (!createdEventId) { t.skip('create did not produce an eventId'); return; }
    const r = await tool.execute({
      op:         'delete',
      calendarId: GOOGLE_CALENDAR_ID,
      eventId:    createdEventId,
    }, ctx);
    assert.equal(r.ok, true, `delete failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    createdEventId = undefined;
  });
});

// ─── googleDrive (read-only) ─────────────────────────────────────────────────

describe('googleDrive — integration', { skip: missingGoogle ? 'GOOGLE_ACCESS_TOKEN not set' : false }, () => {
  const tool = createGoogleDriveTool({ getClient: makeDriveClient });
  const ctx  = makeIntCtx('googleDrive');

  it('list: returns recent Drive files (may be empty)', async () => {
    const r = await tool.execute({ op: 'list', limit: 5 }, ctx);
    assert.equal(r.ok, true, `list failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok(Array.isArray((r as any).value.data));
  });

  it('search: searches for files matching "test"', async () => {
    const r = await tool.execute({ op: 'search', query: 'test', limit: 5 }, ctx);
    assert.equal(r.ok, true, `search failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok(Array.isArray((r as any).value.data));
  });

  it('get: reads the first file metadata if any exist', async () => {
    const list = await tool.execute({ op: 'list', limit: 1 }, ctx);
    if (!list.ok) { return; }
    const files = (list as any).value.data as Array<{ fileId: string }>;
    if (files.length === 0) {
      noopLogger.info('googleDrive.get', { skipped: 'Drive is empty' });
      return;
    }
    const { fileId } = files[0]!;

    const r = await tool.execute({ op: 'get', fileId }, ctx);
    assert.equal(r.ok, true, `get failed: ${!r.ok ? JSON.stringify((r as any).error) : ''}`);
    assert.ok((r as any).value.data);
  });
});
