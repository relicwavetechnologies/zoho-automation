import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createZohoAttachmentService,
  type ZohoAttachmentSourcePort,
} from '../../src/application/zoho/zoho-attachment.service.ts';
import type { ZohoBooksMutationRequest } from '../../src/application/zoho/zoho-books-write.ts';
import { WriteNotDispatchedError } from '../../src/shared/errors.ts';

const sourcePdf: ZohoAttachmentSourcePort = {
  resolve: async input => ({
    kind: 'resolved',
    fileName: input.fileName,
    mimeType: 'application/pdf',
    content: Buffer.from('%PDF-1.4\n'),
  }),
};

describe('Zoho attachment service', () => {
  it('uploads a Lark file and reports attached only after Zoho lists it', async () => {
    const writes: ZohoBooksMutationRequest[] = [];
    const progress: string[] = [];
    let readCount = 0;

    const attachments = createZohoAttachmentService({
      attachmentSource: sourcePdf,
      companyId: 'co-1',
      userId: 'user-1',
      channel: 'lark',
      chatId: 'chat-1',
      readRecord: async (moduleName, recordId, destination) => {
        assert.equal(moduleName, 'bills');
        assert.equal(recordId, 'bill-1');
        assert.deepEqual(destination, { connectionId: 'conn-1', organizationId: 'org-1' });
        readCount += 1;
        return readCount === 1
          ? { documents: [] }
          : { documents: [{ file_name: 'source.pdf' }] };
      },
      write: async request => {
        writes.push(request);
      },
      onProgress: message => progress.push(message),
    });

    const outcome = await attachments.attach({
      recordType: 'bill',
      recordId: 'bill-1',
      fileName: 'source.pdf',
      destination: { connectionId: 'conn-1', organizationId: 'org-1' },
    });

    assert.equal(outcome.outcome, 'attached');
    assert.match(outcome.message, /Attached "source\.pdf"/);
    assert.equal(readCount, 2);
    assert.deepEqual(progress, ['Attaching source.pdf to the bill…']);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.path, '/bills/bill-1/attachment');
    assert.equal(writes[0]?.connectionId, 'conn-1');
    assert.equal(writes[0]?.organizationId, 'org-1');
    assert.equal(writes[0]?.multipart?.fileName, 'source.pdf');
  });

  it('does not upload the same named document twice', async () => {
    let resolved = false;
    let wrote = false;
    const attachments = createZohoAttachmentService({
      attachmentSource: {
        resolve: async () => {
          resolved = true;
          return { kind: 'unavailable', message: 'should not resolve' };
        },
      },
      companyId: 'co-1',
      userId: 'user-1',
      channel: 'lark',
      chatId: 'chat-1',
      readRecord: async () => ({ documents: [{ file_name: 'SOURCE.pdf' }] }),
      write: async () => {
        wrote = true;
      },
    });

    const outcome = await attachments.attach({
      recordType: 'invoice',
      recordId: 'inv-1',
      fileName: 'source.pdf',
    });

    assert.equal(outcome.outcome, 'attached');
    assert.match(outcome.message, /already attached/);
    assert.equal(resolved, false);
    assert.equal(wrote, false);
  });

  it('uploads a web-held file through the same attachment service', async () => {
    let resolved = false;
    let consumed = false;
    const writes: ZohoBooksMutationRequest[] = [];
    let readCount = 0;
    const attachments = createZohoAttachmentService({
      attachmentSource: {
        resolve: async () => {
          resolved = true;
          return {
            kind: 'resolved',
            fileName: 'source.pdf',
            mimeType: 'application/pdf',
            content: Buffer.from('%PDF-1.4\n'),
            onAttached: async () => { consumed = true; },
          };
        },
      },
      companyId: 'co-1',
      userId: 'user-1',
      channel: 'web',
      chatId: 'web-thread-1',
      readRecord: async () => {
        readCount += 1;
        return readCount === 1
          ? { documents: [] }
          : { documents: [{ file_name: 'source.pdf' }] };
      },
      write: async request => { writes.push(request); },
    });

    const outcome = await attachments.attach({
      recordType: 'bill',
      recordId: 'bill-1',
      fileName: 'source.pdf',
    });

    assert.equal(outcome.outcome, 'attached');
    assert.equal(resolved, true);
    assert.equal(consumed, true);
    assert.equal(writes[0]?.multipart?.fileName, 'source.pdf');
  });

  it('refuses a web upload when Zoho already has the same filename', async () => {
    let resolved = false;
    let wrote = false;
    let readCount = 0;
    const attachments = createZohoAttachmentService({
      attachmentSource: {
        resolve: async () => {
          resolved = true;
          return {
            kind: 'resolved',
            fileName: 'source.pdf',
            mimeType: 'application/pdf',
            content: Buffer.from('%PDF corrected\n'),
          };
        },
      },
      companyId: 'co-1',
      userId: 'user-1',
      channel: 'web',
      chatId: 'web-thread-1',
      readRecord: async () => {
        readCount += 1;
        return { documents: [{ file_name: 'SOURCE.pdf' }] };
      },
      write: async () => {
        wrote = true;
      },
    });

    const outcome = await attachments.attach({
      recordType: 'bill',
      recordId: 'bill-1',
      fileName: 'source.pdf',
    });

    assert.equal(outcome.outcome, 'refused');
    assert.match(outcome.message, /Rename the uploaded file/);
    assert.equal(resolved, true);
    assert.equal(wrote, false);
    assert.equal(readCount, 1);
  });

  it('separates never-sent uploads from uncertain provider uploads', async () => {
    const base = {
      attachmentSource: sourcePdf,
      companyId: 'co-1',
      userId: 'user-1',
      channel: 'lark',
      chatId: 'chat-1',
      readRecord: async () => ({ documents: [] }),
    };

    const unsent = await createZohoAttachmentService({
      ...base,
      write: async () => {
        throw new WriteNotDispatchedError('missing write access');
      },
    }).attach({ recordType: 'bill', recordId: 'bill-1', fileName: 'source.pdf' });

    const uncertain = await createZohoAttachmentService({
      ...base,
      write: async () => {
        throw new Error('Zoho Books 503 Service Unavailable: ');
      },
    }).attach({ recordType: 'bill', recordId: 'bill-1', fileName: 'source.pdf' });

    assert.equal(unsent.outcome, 'refused');
    assert.match(unsent.message, /never sent/);
    assert.equal(uncertain.outcome, 'unconfirmed');
    assert.match(uncertain.message, /did not accept the upload cleanly/);
  });
});
