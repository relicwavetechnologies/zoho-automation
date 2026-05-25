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
import { buildArgsSummary }         from '../../src/application/orchestration/tools/ai-sdk-adapter.ts';

// ─── gmail ────────────────────────────────────────────────────────────────────

describe('googleGmail tool', () => {
  const fakeGmailClient = {
    listMessages:   async () => [{ messageId: 'm1', threadId: 'th1', subject: 'Hi', from: 'a@b.com', snippet: '...', timestamp: 'ts', isUnread: false }],
    getMessage:     async () => ({ messageId: 'm1', threadId: 'th1', subject: 'Hi', from: 'a@b.com', to: ['b@c.com'], cc: [], bcc: [], body: 'body', snippet: '...', timestamp: 'ts', isUnread: false, labelIds: [], references: [] }),
    sendMessage:    async () => ({ messageId: 'm-sent', threadId: 'th1' }),
    searchMessages: async () => [{ messageId: 'm2', subject: 'Re', from: 'x@y.com', snippet: '...', timestamp: 'ts' }],
    createDraft:    async () => ({ draftId: 'd1', messageId: 'm-draft', threadId: 'th1' }),
    getDraft:       async () => ({ draftId: 'd1', message: { messageId: 'm-draft', threadId: 'th1', subject: 'Draft', from: 'me@example.com', to: ['b@c.com'], cc: [], bcc: [], body: 'body', snippet: '...', timestamp: 'ts', isUnread: false, labelIds: ['DRAFT'], references: [] } }),
    updateDraft:    async () => ({ draftId: 'd1', messageId: 'm-draft2', threadId: 'th1' }),
    deleteDraft:    async () => {},
    sendDraft:      async () => ({ messageId: 'm-sent-draft', threadId: 'th1' }),
    listThreads:    async () => [{ threadId: 'th1', messageCount: 2, latestMessageId: 'm2', subject: 'Hi', participants: ['a@b.com'], snippet: '...', timestamp: 'ts' }],
    getThread:      async () => ({ threadId: 'th1', subject: 'Hi', participants: ['a@b.com'], snippet: '...', messages: [] }),
    replyToMessage: async () => ({ messageId: 'm-reply', threadId: 'th1' }),
    forwardMessage: async () => ({ messageId: 'm-forward', threadId: 'th2' }),
    listLabels:     async () => [{ id: 'Label_1', name: 'Clients', type: 'user' }],
    applyLabels:    async () => ({ modified: 1, labelIds: ['Label_1'] }),
    removeLabels:   async () => ({ modified: 1, labelIds: ['Label_1'] }),
    archiveMessages: async () => ({ modified: 1 }),
    markRead:       async () => ({ modified: 1 }),
    markUnread:     async () => ({ modified: 1 }),
    starMessages:   async () => ({ modified: 1 }),
    unstarMessages: async () => ({ modified: 1 }),
    trashMessages:  async () => ({ modified: 1 }),
    untrashMessages: async () => ({ modified: 1 }),
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

    it('maps draft and mailbox ops to create/update/delete actions', () => {
      const tool = createGoogleGmailTool({ getClient: noClient });
      assert.equal((tool.permissionCheck({ op: 'draft_create' }, makeAllowedPerm('googleGmail', ['create'])) as any).value, 'create');
      assert.equal((tool.permissionCheck({ op: 'archive', messageId: 'm1' }, makeAllowedPerm('googleGmail', ['update'])) as any).value, 'update');
      assert.equal((tool.permissionCheck({ op: 'draft_delete', draftId: 'd1' }, makeAllowedPerm('googleGmail', ['delete'])) as any).value, 'delete');
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

    it('send: resolves attachments and passes resolved bytes to the client', async () => {
      let sentArgs: any;
      let resolveCtx: any;
      const resolved = [{
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 3,
        content: Buffer.from('pdf'),
        source: 'file_asset' as const,
      }];
      const tool = createGoogleGmailTool({
        getClient: async () => ({
          ...fakeGmailClient,
          sendMessage: async (args: any) => {
            sentArgs = args;
            return { messageId: 'm-sent' };
          },
        }),
        resolveAttachments: async (refs, rctx) => {
          resolveCtx = rctx;
          assert.deepEqual(refs, [{ source: 'file_asset', fileAssetId: 'f1' }]);
          return { ok: true, value: resolved };
        },
      });

      const r = await tool.execute({
        op: 'send',
        to: ['b@c.com'],
        subject: 'Greet',
        bodyText: 'Hello',
        attachments: [{ source: 'file_asset', fileAssetId: 'f1' }],
      }, ctx);

      assert.equal(r.ok, true);
      assert.deepEqual(resolveCtx, { companyId: 'co-test', userId: 'user-test' });
      assert.equal(sentArgs.attachments, resolved);
    });

    it('send: rejects attachment resolution failures before Gmail API calls', async () => {
      let called = false;
      const tool = createGoogleGmailTool({
        getClient: async () => ({
          ...fakeGmailClient,
          sendMessage: async () => {
            called = true;
            return { messageId: 'm-sent' };
          },
        }),
        resolveAttachments: async () => ({
          ok: false,
          error: { code: 'file_too_large', message: 'File exceeds the 10 MB limit.' },
        }),
      });
      const r = await tool.execute({
        op: 'send',
        to: ['b@c.com'],
        subject: 'Greet',
        bodyText: 'Hello',
        attachments: [{ source: 'google_drive', fileId: 'drive-1' }],
      }, ctx);
      assert.equal(r.ok, false);
      assert.equal(called, false);
      assert.equal((r as any).error.payload.reason, 'bad_args');
      assert.match((r as any).error.message, /10 MB/);
    });

    it('send: accepts bodyText alias and cc recipients', async () => {
      let sentArgs: unknown;
      const tool = createGoogleGmailTool({
        getClient: async () => ({
          ...fakeGmailClient,
          sendMessage: async (args: unknown) => {
            sentArgs = args;
            return { messageId: 'm-sent' };
          },
        }),
      });
      const r = await tool.execute({
        op: 'send',
        to: ['b@c.com'],
        cc: ['c@d.com'],
        subject: 'Greet',
        bodyText: 'Hello',
      }, ctx);
      assert.equal(r.ok, true);
      assert.deepEqual(sentArgs, {
        to: ['b@c.com'],
        cc: ['c@d.com'],
        subject: 'Greet',
        body: 'Hello',
      });
    });

    it('send: plain bodyText passed through without template wrapping', async () => {
      let sentArgs: any;
      const tool = createGoogleGmailTool({
        getClient: async () => ({
          ...fakeGmailClient,
          sendMessage: async (args: any) => {
            sentArgs = args;
            return { messageId: 'm-sent' };
          },
        }),
      });
      const bodyText = 'Hi Anish,\n\nThe latest stock price is ₹107.60.\n\nBest regards,\nDivo';
      const r = await tool.execute({
        op: 'send',
        to: ['client@acme.co'],
        subject: 'Stock price',
        bodyText,
      }, ctx);
      assert.equal(r.ok, true);
      assert.equal(sentArgs.template, undefined);
      assert.equal(sentArgs.body, bodyText);
    });

    it('send: rejects title-only templates with no rendered body content', async () => {
      let called = false;
      const tool = createGoogleGmailTool({
        getClient: async () => ({
          ...fakeGmailClient,
          sendMessage: async () => {
            called = true;
            return { messageId: 'm-sent' };
          },
        }),
      });
      const r = await tool.execute({
        op: 'send',
        to: ['anishsuman2305@gmail.com'],
        subject: 'Total Payment Received',
        templateId: 'divo-finance-v1',
        templateData: { title: 'Total Payment Received' },
      }, ctx);
      assert.equal(r.ok, false);
      assert.equal(called, false);
      assert.equal((r as any).error.payload.reason, 'bad_args');
      assert.match((r as any).error.message, /Email body content required/);
    });

    it('send: finance body text sent as plain text (template disabled)', async () => {
      let sentArgs: any;
      const tool = createGoogleGmailTool({
        getClient: async () => ({
          ...fakeGmailClient,
          sendMessage: async (args: any) => {
            sentArgs = args;
            return { messageId: 'm-sent' };
          },
        }),
      });
      const bodyText = 'The total payment received by the company to date is ₹62,71,81,387.60 across 4,000 transactions.';
      const r = await tool.execute({
        op: 'send',
        to: ['anishsuman2305@gmail.com'],
        subject: 'Total Payment Received',
        bodyText,
        templateId: 'divo-finance-v1',
        templateData: { title: 'Total Payment Received' },
      }, ctx);
      assert.equal(r.ok, true);
      assert.equal(sentArgs.body, bodyText);
      assert.equal(sentArgs.template, undefined);
    });

    it('send: templateId/templateData ignored, plain text sent (template disabled)', async () => {
      let sentArgs: any;
      const tool = createGoogleGmailTool({
        getClient: async () => ({
          ...fakeGmailClient,
          sendMessage: async (args: any) => {
            sentArgs = args;
            return { messageId: 'm-sent' };
          },
        }),
      });
      const r = await tool.execute({
        op: 'send',
        to: ['client@acme.co'],
        subject: 'Set up your Divo account',
        bodyText: 'Your workspace account is ready. Use the link below to finish setup.\n\nhttps://app.divo.example/setup?token=abc123',
        templateId: 'divo-executive-v1',
        templateData: {
          title: 'Set up your Divo account',
          cta: {
            label: 'Set Up My Account',
            url: 'https://app.divo.example/setup?token=abc123',
          },
        },
      }, ctx);
      assert.equal(r.ok, true);
      assert.equal(sentArgs.template, undefined);
      assert.match(sentArgs.body, /https:\/\/app\.divo\.example\/setup/);
    });

    it('send: URLs in bodyText are sent as plain text (no template extraction)', async () => {
      let sentArgs: any;
      const tool = createGoogleGmailTool({
        getClient: async () => ({
          ...fakeGmailClient,
          sendMessage: async (args: any) => {
            sentArgs = args;
            return { messageId: 'm-sent' };
          },
        }),
      });
      const bodyText = [
        'Hi Anish, here are two links for the best bikes of 2026:',
        '1. https://www.bicycling.com/bikes-gear/a123/best-bikes-2026',
        '2. https://www.cyclingweekly.com/group-tests/best-road-bikes',
      ].join('\n');
      const r = await tool.execute({
        op: 'send',
        to: ['anishsuman2305@gmail.com'],
        subject: 'Best Bikes 2026',
        bodyText,
      }, ctx);
      assert.equal(r.ok, true);
      assert.equal(sentArgs.template, undefined);
      assert.equal(sentArgs.body, bodyText);
    });

    it('send: rejects link promises when URLs are missing', async () => {
      let called = false;
      const tool = createGoogleGmailTool({
        getClient: async () => ({
          ...fakeGmailClient,
          sendMessage: async () => {
            called = true;
            return { messageId: 'm-sent' };
          },
        }),
      });
      const r = await tool.execute({
        op: 'send',
        to: ['anishsuman2305@gmail.com'],
        subject: 'Best Bikes 2026',
        bodyText: 'Hi Anish, here are two links for the best bikes of 2026:',
      }, ctx);
      assert.equal(r.ok, false);
      assert.equal(called, false);
      assert.equal((r as any).error.payload.reason, 'bad_args');
      assert.match((r as any).error.message, /mentions links\/buttons but no URL/);
    });

    it('draft_create: creates a real draft through the client', async () => {
      let draftArgs: any;
      const tool = createGoogleGmailTool({
        getClient: async () => ({
          ...fakeGmailClient,
          createDraft: async (args: any) => {
            draftArgs = args;
            return { draftId: 'd1', messageId: 'm-draft', threadId: 'th1' };
          },
        }),
      });
      const r = await tool.execute({ op: 'draft_create', to: ['b@c.com'], subject: 'Draft', bodyText: 'Hello' }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.draftId, 'd1');
      assert.equal(draftArgs.template, undefined);
      assert.equal(draftArgs.body, 'Hello');
    });

    it('draft_create: passes attachments through after resolution', async () => {
      let draftArgs: any;
      const resolved = [{
        fileName: 'export.csv',
        mimeType: 'text/csv',
        sizeBytes: 3,
        content: Buffer.from('csv'),
        source: 'outbound_artifact' as const,
      }];
      const tool = createGoogleGmailTool({
        getClient: async () => ({
          ...fakeGmailClient,
          createDraft: async (args: any) => {
            draftArgs = args;
            return { draftId: 'd1' };
          },
        }),
        resolveAttachments: async () => ({ ok: true, value: resolved }),
      });
      const r = await tool.execute({
        op: 'draft_create',
        to: ['b@c.com'],
        subject: 'Draft',
        bodyText: 'Hello',
        attachments: [{ source: 'outbound_artifact', artifactId: 'a1' }],
      }, ctx);
      assert.equal(r.ok, true);
      assert.equal(draftArgs.attachments, resolved);
    });

    it('send: passes bcc, plain text only (HTML template disabled)', async () => {
      let sentArgs: any;
      const tool = createGoogleGmailTool({
        getClient: async () => ({
          ...fakeGmailClient,
          sendMessage: async (args: any) => {
            sentArgs = args;
            return { messageId: 'm-sent' };
          },
        }),
      });
      const r = await tool.execute({
        op: 'send',
        to: ['b@c.com'],
        bcc: ['secret@acme.co'],
        subject: 'Greet',
        bodyText: 'Hello',
        bodyHtml: '<p>Hello</p>',
        templateId: 'divo-standard-v1',
      }, ctx);
      assert.equal(r.ok, true);
      assert.deepEqual(sentArgs.bcc, ['secret@acme.co']);
      assert.equal(sentArgs.bodyHtml, undefined);
      assert.equal(sentArgs.template, undefined);
      assert.equal(sentArgs.body, 'Hello');
    });

    it('send: blocks placeholder recipient domains before Gmail API call', async () => {
      let called = false;
      const tool = createGoogleGmailTool({
        getClient: async () => ({
          ...fakeGmailClient,
          sendMessage: async () => {
            called = true;
            return { messageId: 'm-sent' };
          },
        }),
      });
      const r = await tool.execute({
        op: 'send',
        to: ['anish.suman@example.com'],
        subject: 'Stock price',
        bodyText: 'Latest stock price.',
      }, ctx);
      assert.equal(r.ok, false);
      assert.equal(called, false);
      assert.equal((r as any).error.payload.reason, 'bad_args');
      assert.match((r as any).error.message, /placeholder or test domain/);
      assert.match((r as any).error.message, /Lark contacts\/context search/);
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

    it('reply_all and forward use message context methods', async () => {
      const calls: any[] = [];
      const tool = createGoogleGmailTool({
        getClient: async () => ({
          ...fakeGmailClient,
          replyToMessage: async (_messageId: string, args: any) => {
            calls.push({ kind: 'reply', args });
            return { messageId: 'm-reply', threadId: 'th1' };
          },
          forwardMessage: async (_messageId: string, args: any) => {
            calls.push({ kind: 'forward', args });
            return { messageId: 'm-forward', threadId: 'th2' };
          },
        }),
      });
      const reply = await tool.execute({ op: 'reply_all', messageId: 'm1', bodyText: 'ok' }, ctx);
      const forward = await tool.execute({ op: 'forward', messageId: 'm1', to: ['next@acme.co'] }, ctx);
      assert.equal(reply.ok, true);
      assert.equal((reply as any).value.messageId, 'm-reply');
      assert.equal(forward.ok, true);
      assert.equal((forward as any).value.messageId, 'm-forward');
      assert.equal(calls[0].args.template, undefined);
      assert.equal(calls[0].args.body, 'ok');
      assert.equal(calls[1].args.template, undefined);
    });

    it('thread and mailbox operations execute through the client', async () => {
      const tool = createGoogleGmailTool({ getClient: yesClient });
      assert.equal((await tool.execute({ op: 'thread_list' }, ctx)).ok, true);
      assert.equal((await tool.execute({ op: 'thread_get', threadId: 'th1' }, ctx)).ok, true);
      assert.equal((await tool.execute({ op: 'label_list' }, ctx)).ok, true);
      assert.equal((await tool.execute({ op: 'label_apply', messageId: 'm1', labelNames: ['Clients'] }, ctx)).ok, true);
      assert.equal((await tool.execute({ op: 'archive', messageId: 'm1' }, ctx)).ok, true);
      assert.equal((await tool.execute({ op: 'mark_read', messageId: 'm1' }, ctx)).ok, true);
      assert.equal((await tool.execute({ op: 'star', messageId: 'm1' }, ctx)).ok, true);
      assert.equal((await tool.execute({ op: 'trash', messageId: 'm1' }, ctx)).ok, true);
    });

    it('approval summary exposes safe Gmail details without raw ids', () => {
      const summary = buildArgsSummary('googleGmail', 'send', {
        op: 'send',
        to: ['client@example.com'],
        cc: ['manager@example.com'],
        bcc: ['audit@example.com'],
        subject: 'Proposal',
        bodyText: 'Here is the proposal for review.',
        templateId: 'divo-proposal-v1',
        messageId: 'raw-message-id',
      });
      assert.match(summary, /googleGmail\.send/);
      assert.match(summary, /to=client@example\.com/);
      assert.match(summary, /cc=1/);
      assert.match(summary, /bcc=1/);
      assert.match(summary, /template=divo-proposal-v1/);
      assert.doesNotMatch(summary, /raw-message-id/);
    });

    it('approval summary includes attachment count and sources', () => {
      const summary = buildArgsSummary('googleGmail', 'send', {
        op: 'send',
        to: ['client@example.com'],
        subject: 'Report',
        bodyText: 'Attached.',
        attachments: [
          { source: 'file_asset', fileAssetId: 'f1' },
          { source: 'google_drive', fileId: 'd1' },
        ],
      });

      assert.match(summary, /attachments=2/);
      assert.match(summary, /sources=file_asset,google_drive/);
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
