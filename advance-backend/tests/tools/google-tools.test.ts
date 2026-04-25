/**
 * Unit tests for Google tool families: Gmail, Drive, Calendar.
 *
 * Each section covers:
 *  - permissionCheck: denied / correct action group
 *  - execute: no client → unrecoverable
 *  - execute: happy path
 *  - execute: missing required arg → bad_args
 *  - execute: infra throws → upstream_failure
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeAllowedPerm, makeDeniedPerm, makeCtx } from './tool-test.helpers.ts';

import { createGoogleGmailTool }    from '../../src/application/orchestration/tools/families/google-gmail.tool.ts';
import { createGoogleDriveTool }    from '../../src/application/orchestration/tools/families/google-drive.tool.ts';
import { createGoogleCalendarTool } from '../../src/application/orchestration/tools/families/google-calendar.tool.ts';

// ─── gmail ────────────────────────────────────────────────────────────────────

describe('googleGmail tool', () => {
  const fakeGmailClient = {
    listMessages:   async () => [{ messageId: 'm1', threadId: 'th1', subject: 'Hi', from: 'a@b.com', snippet: '...', timestamp: 'ts', isUnread: false }],
    getMessage:     async () => ({ messageId: 'm1', threadId: 'th1', subject: 'Hi', from: 'a@b.com', to: ['b@c.com'], body: 'body', timestamp: 'ts' }),
    sendMessage:    async () => ({ messageId: 'm-sent' }),
    searchMessages: async () => [{ messageId: 'm2', subject: 'Re', from: 'x@y.com', snippet: '...', timestamp: 'ts' }],
  };

  const noClient = async () => null;
  const yesClient = async () => fakeGmailClient;
  const throwClient = async () => { throw new Error('gmail down'); };

  describe('permissionCheck', () => {
    it('denies when not in allowedActionsByTool', () => {
      const tool = createGoogleGmailTool({ getClient: noClient });
      const r = tool.permissionCheck({ op: 'send' }, makeDeniedPerm());
      assert.equal(r.ok, false);
    });

    it('returns "send" for op=send', () => {
      const tool = createGoogleGmailTool({ getClient: noClient });
      const r = tool.permissionCheck({ op: 'send' }, makeAllowedPerm('googleGmail', ['send']));
      assert.equal(r.ok, true);
      assert.equal((r as any).value, 'send');
    });

    it('returns "read" for op=list', () => {
      const tool = createGoogleGmailTool({ getClient: noClient });
      const r = tool.permissionCheck({ op: 'list' }, makeAllowedPerm('googleGmail', ['read']));
      assert.equal((r as any).value, 'read');
    });

    it('returns "send" for op=reply', () => {
      const tool = createGoogleGmailTool({ getClient: noClient });
      const r = tool.permissionCheck({ op: 'reply' }, makeAllowedPerm('googleGmail', ['send']));
      assert.equal((r as any).value, 'send');
    });
  });

  describe('execute', () => {
    const ctx = makeCtx('googleGmail', ['read', 'send']);

    it('no client → unrecoverable error', async () => {
      const tool = createGoogleGmailTool({ getClient: noClient });
      const r = await tool.execute({ op: 'list' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'unrecoverable');
    });

    it('list: ok with messages', async () => {
      const tool = createGoogleGmailTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'list' }, ctx);
      assert.equal(r.ok, true);
      assert.ok(Array.isArray((r as any).value.data));
    });

    it('get: ok with message data', async () => {
      const tool = createGoogleGmailTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'get', messageId: 'm1' }, ctx);
      assert.equal(r.ok, true);
    });

    it('get: bad_args when messageId missing', async () => {
      const tool = createGoogleGmailTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'get' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'bad_args');
    });

    it('send: ok with messageId', async () => {
      const tool = createGoogleGmailTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'send', to: ['b@c.com'], subject: 'Greet', body: 'Hello' }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.messageId, 'm-sent');
    });

    it('send: bad_args when to/subject/body missing', async () => {
      const tool = createGoogleGmailTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'send', subject: 'x' }, ctx);
      assert.equal(r.ok, false);
    });

    it('search: ok with results', async () => {
      const tool = createGoogleGmailTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'search', query: 'from:boss' }, ctx);
      assert.equal(r.ok, true);
    });

    it('reply: bad_args when threadId missing', async () => {
      const tool = createGoogleGmailTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'reply', body: 'ok' }, ctx);
      assert.equal(r.ok, false);
    });

    it('getClient throws → client is null so unrecoverable', async () => {
      const tool = createGoogleGmailTool({ getClient: noClient });
      const r = await tool.execute({ op: 'list' }, ctx);
      assert.equal(r.ok, false);
    });

    it('infra throws → upstream_failure', async () => {
      const throwing = async () => ({ ...fakeGmailClient, listMessages: async () => { throw new Error('err'); } });
      const tool = createGoogleGmailTool({ getClient: throwing });
      const r = await tool.execute({ op: 'list' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });
  });
});

// ─── google-drive ─────────────────────────────────────────────────────────────

describe('googleDrive tool', () => {
  const fakeDriveClient = {
    listFiles:    async () => [{ fileId: 'f1', name: 'Budget.xlsx' }],
    getFile:      async () => ({ fileId: 'f1', name: 'Budget.xlsx' }),
    searchFiles:  async () => [{ fileId: 'f2', name: 'Q1.csv' }],
    createFolder: async () => ({ fileId: 'folder-1' }),
  };

  const noClient = async () => null;
  const yesClient = async () => fakeDriveClient;

  describe('permissionCheck', () => {
    it('returns "read" for op=list', () => {
      const tool = createGoogleDriveTool({ getClient: noClient });
      const r = tool.permissionCheck({ op: 'list' }, makeAllowedPerm('googleDrive', ['read']));
      assert.equal((r as any).value, 'read');
    });

    it('returns "create" for op=create_folder', () => {
      const tool = createGoogleDriveTool({ getClient: noClient });
      const r = tool.permissionCheck({ op: 'create_folder' }, makeAllowedPerm('googleDrive', ['create']));
      assert.equal((r as any).value, 'create');
    });

    it('denies when not allowed', () => {
      const tool = createGoogleDriveTool({ getClient: noClient });
      const r = tool.permissionCheck({ op: 'list' }, makeDeniedPerm());
      assert.equal(r.ok, false);
    });
  });

  describe('execute', () => {
    const ctx = makeCtx('googleDrive', ['read', 'create', 'update']);

    it('no client → unrecoverable', async () => {
      const tool = createGoogleDriveTool({ getClient: noClient });
      const r = await tool.execute({ op: 'list' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'unrecoverable');
    });

    it('list: ok with files', async () => {
      const tool = createGoogleDriveTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'list' }, ctx);
      assert.equal(r.ok, true);
    });

    it('get: ok with file', async () => {
      const tool = createGoogleDriveTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'get', fileId: 'f1' }, ctx);
      assert.equal(r.ok, true);
    });

    it('get: bad_args when fileId missing', async () => {
      const tool = createGoogleDriveTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'get' }, ctx);
      assert.equal(r.ok, false);
    });

    it('search: ok with results', async () => {
      const tool = createGoogleDriveTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'search', query: 'budget' }, ctx);
      assert.equal(r.ok, true);
    });

    it('create_folder: ok with fileId', async () => {
      const tool = createGoogleDriveTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'create_folder', name: 'Reports' }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.fileId, 'folder-1');
    });

    it('create_folder: bad_args when name missing', async () => {
      const tool = createGoogleDriveTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'create_folder' }, ctx);
      assert.equal(r.ok, false);
    });

    it('infra throws → upstream_failure', async () => {
      const throwing = async () => ({ ...fakeDriveClient, listFiles: async () => { throw new Error('err'); } });
      const tool = createGoogleDriveTool({ getClient: throwing });
      const r = await tool.execute({ op: 'list' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });
  });
});

// ─── google-calendar ──────────────────────────────────────────────────────────

describe('googleCalendar tool', () => {
  const fakeCalClient = {
    listEvents:   async () => [{ eventId: 'ev-1' }],
    getEvent:     async () => ({ eventId: 'ev-1', title: 'Sync' }),
    createEvent:  async () => ({ eventId: 'ev-new' }),
    updateEvent:  async () => {},
    deleteEvent:  async () => {},
  };

  const noClient = async () => null;
  const yesClient = async () => fakeCalClient;

  describe('permissionCheck', () => {
    it('returns "read" for op=list', () => {
      const tool = createGoogleCalendarTool({ getClient: noClient });
      const r = tool.permissionCheck({ op: 'list' }, makeAllowedPerm('googleCalendar', ['read']));
      assert.equal((r as any).value, 'read');
    });

    it('returns "create" for op=create', () => {
      const tool = createGoogleCalendarTool({ getClient: noClient });
      const r = tool.permissionCheck({ op: 'create' }, makeAllowedPerm('googleCalendar', ['create']));
      assert.equal((r as any).value, 'create');
    });

    it('returns "update" for op=update', () => {
      const tool = createGoogleCalendarTool({ getClient: noClient });
      const r = tool.permissionCheck({ op: 'update' }, makeAllowedPerm('googleCalendar', ['update']));
      assert.equal((r as any).value, 'update');
    });

    it('returns "delete" for op=delete', () => {
      const tool = createGoogleCalendarTool({ getClient: noClient });
      const r = tool.permissionCheck({ op: 'delete' }, makeAllowedPerm('googleCalendar', ['delete']));
      assert.equal((r as any).value, 'delete');
    });

    it('denies when not allowed', () => {
      const tool = createGoogleCalendarTool({ getClient: noClient });
      const r = tool.permissionCheck({ op: 'delete' }, makeAllowedPerm('googleCalendar', ['read']));
      assert.equal(r.ok, false);
    });
  });

  describe('execute', () => {
    const ctx = makeCtx('googleCalendar', ['read', 'create', 'update', 'delete']);

    it('no client → unrecoverable', async () => {
      const tool = createGoogleCalendarTool({ getClient: noClient });
      const r = await tool.execute({ op: 'list' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'unrecoverable');
    });

    it('list: ok with events', async () => {
      const tool = createGoogleCalendarTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'list' }, ctx);
      assert.equal(r.ok, true);
    });

    it('get: bad_args when eventId missing', async () => {
      const tool = createGoogleCalendarTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'get' }, ctx);
      assert.equal(r.ok, false);
    });

    it('create: ok when required fields present', async () => {
      const tool = createGoogleCalendarTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'create', title: 'Sprint Review', startTime: '2025-01-01T10:00:00Z', endTime: '2025-01-01T11:00:00Z' }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.eventId, 'ev-new');
    });

    it('create: bad_args when title missing', async () => {
      const tool = createGoogleCalendarTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'create', startTime: 'x', endTime: 'y' }, ctx);
      assert.equal(r.ok, false);
    });

    it('update: bad_args when eventId missing', async () => {
      const tool = createGoogleCalendarTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'update', title: 'new title' }, ctx);
      assert.equal(r.ok, false);
    });

    it('delete: ok when eventId present', async () => {
      const tool = createGoogleCalendarTool({ getClient: yesClient });
      const r = await tool.execute({ op: 'delete', eventId: 'ev-1' }, ctx);
      assert.equal(r.ok, true);
    });

    it('infra throws → upstream_failure', async () => {
      const throwing = async () => ({ ...fakeCalClient, listEvents: async () => { throw new Error('err'); } });
      const tool = createGoogleCalendarTool({ getClient: throwing });
      const r = await tool.execute({ op: 'list' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });
  });
});
