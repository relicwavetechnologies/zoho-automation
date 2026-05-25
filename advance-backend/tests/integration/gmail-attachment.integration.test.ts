import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EmailComposerService } from '../../src/application/email/email-composer.service.ts';
import { createGoogleGmailTool } from '../../src/application/orchestration/tools/families/google-gmail.tool.ts';
import { makeCtx } from '../tools/tool-test.helpers.ts';

describe('gmail attachment integration flow', () => {
  const ctx = makeCtx('googleGmail', ['send', 'create']);

  function clientWithComposer(raws: string[]) {
    const composer = new EmailComposerService();
    return {
      listMessages: async () => [],
      getMessage: async () => ({
        messageId: 'm1',
        threadId: 't1',
        subject: 'Original',
        from: 'sender@example.com',
        to: ['me@example.com'],
        cc: [],
        bcc: [],
        body: 'Original body',
        snippet: '',
        timestamp: '2026-01-01T00:00:00.000Z',
        isUnread: false,
        labelIds: [],
        references: [],
      }),
      sendMessage: async (params: any) => {
        raws.push(composer.compose({
          to: params.to.map((email: string) => ({ email })),
          subject: params.subject,
          ...(params.body ? { text: params.body } : {}),
          ...(params.bodyHtml ? { html: params.bodyHtml } : {}),
          ...(params.template ? { template: params.template } : {}),
          ...(params.attachments ? { attachments: params.attachments } : {}),
        }).raw);
        return { messageId: 'sent-1' };
      },
      searchMessages: async () => [],
      createDraft: async (params: any) => {
        raws.push(composer.compose({
          to: params.to.map((email: string) => ({ email })),
          subject: params.subject,
          ...(params.body ? { text: params.body } : {}),
          ...(params.template ? { template: params.template } : {}),
          ...(params.attachments ? { attachments: params.attachments } : {}),
        }).raw);
        return { draftId: 'draft-1' };
      },
      getDraft: async () => { throw new Error('not used'); },
      updateDraft: async () => ({ draftId: 'draft-1' }),
      deleteDraft: async () => {},
      sendDraft: async () => ({ messageId: 'sent-draft' }),
      listThreads: async () => [],
      getThread: async () => { throw new Error('not used'); },
      replyToMessage: async (_messageId: string, params: any) => {
        await (clientWithComposer(raws) as any).sendMessage({
          to: ['sender@example.com'],
          subject: 'Re: Original',
          ...params,
        });
        return { messageId: 'reply-1' };
      },
      forwardMessage: async (_messageId: string, params: any) => {
        await (clientWithComposer(raws) as any).sendMessage({
          ...params,
          subject: params.subject ?? 'Fwd: Original',
        });
        return { messageId: 'forward-1' };
      },
      listLabels: async () => [],
      applyLabels: async () => ({ modified: 0, labelIds: [] }),
      removeLabels: async () => ({ modified: 0, labelIds: [] }),
      archiveMessages: async () => ({ modified: 0 }),
      markRead: async () => ({ modified: 0 }),
      markUnread: async () => ({ modified: 0 }),
      starMessages: async () => ({ modified: 0 }),
      unstarMessages: async () => ({ modified: 0 }),
      trashMessages: async () => ({ modified: 0 }),
      untrashMessages: async () => ({ modified: 0 }),
    };
  }

  it('sends file_asset attachments through resolver into multipart MIME', async () => {
    const raws: string[] = [];
    const tool = createGoogleGmailTool({
      getClient: async () => clientWithComposer(raws),
      resolveAttachments: async () => ({
        ok: true,
        value: [{
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 3,
          content: Buffer.from('pdf'),
          source: 'file_asset',
        }],
      }),
    });

    const result = await tool.execute({
      op: 'send',
      to: ['client@acme.co'],
      subject: 'Report',
      bodyText: 'Attached.',
      attachments: [{ source: 'file_asset', fileAssetId: 'f1' }],
    }, ctx);

    assert.equal(result.ok, true);
    assert.match(raws[0] ?? '', /multipart\/mixed/);
    assert.match(raws[0] ?? '', /filename="report\.pdf"/);
  });

  it('rejects policy violations before composing MIME', async () => {
    const raws: string[] = [];
    const tool = createGoogleGmailTool({
      getClient: async () => clientWithComposer(raws),
      resolveAttachments: async () => ({
        ok: false,
        error: { code: 'file_too_large', message: 'File exceeds the 10 MB limit.' },
      }),
    });

    const result = await tool.execute({
      op: 'send',
      to: ['client@acme.co'],
      subject: 'Report',
      bodyText: 'Attached.',
      attachments: [{ source: 'google_drive', fileId: 'drive-1' }],
    }, ctx);

    assert.equal(result.ok, false);
    assert.equal(raws.length, 0);
  });

  it('supports draft, reply, and forward attachments', async () => {
    const raws: string[] = [];
    const tool = createGoogleGmailTool({
      getClient: async () => clientWithComposer(raws),
      resolveAttachments: async () => ({
        ok: true,
        value: [{
          fileName: 'data.csv',
          mimeType: 'text/csv',
          sizeBytes: 3,
          content: Buffer.from('csv'),
          source: 'outbound_artifact',
        }],
      }),
    });

    assert.equal((await tool.execute({
      op: 'draft_create',
      to: ['client@acme.co'],
      subject: 'Draft',
      bodyText: 'Attached.',
      attachments: [{ source: 'outbound_artifact', artifactId: 'a1' }],
    }, ctx)).ok, true);
    assert.equal((await tool.execute({
      op: 'reply',
      messageId: 'm1',
      bodyText: 'Attached.',
      attachments: [{ source: 'outbound_artifact', artifactId: 'a1' }],
    }, ctx)).ok, true);
    assert.equal((await tool.execute({
      op: 'forward',
      messageId: 'm1',
      to: ['client@acme.co'],
      bodyText: 'Attached.',
      attachments: [{ source: 'outbound_artifact', artifactId: 'a1' }],
    }, ctx)).ok, true);

    assert.equal(raws.length, 3);
    assert.equal(raws.every(raw => raw.includes('filename="data.csv"')), true);
  });
});
