/**
 * The honesty rules a Zoho write reply depends on, tested without Zoho.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachedDocumentNames,
  summarizeZohoWrite,
  unwrapZohoRecord,
} from '../../src/application/zoho/zoho-books-write-result.ts';
import {
  ConversationAttachmentService,
  selectAttachment,
  type ConversationAttachmentRow,
} from '../../src/application/conversation-attachments/conversation-attachment.service.ts';
import { conversationKeyForMessage } from '../../src/domain/conversation/conversation-key.ts';

describe('unwrapZohoRecord', () => {
  it('reads the singular wrapper Zoho uses for most modules', () => {
    const record = unwrapZohoRecord({ invoice: { invoice_id: 'inv-1' } }, 'invoices');
    assert.equal(record['invoice_id'], 'inv-1');
  });

  it('reads customerpayments, which Zoho wraps as "payment" rather than the module name', () => {
    // Deriving the key by stripping the trailing "s" yields "customerpayment",
    // which is absent — the whole record was being dropped and the payment came
    // back with no id at all.
    const record = unwrapZohoRecord({ payment: { payment_id: 'pay-1' } }, 'customerpayments');
    assert.equal(record['payment_id'], 'pay-1');
  });

  it('falls back to the payload when no wrapper is present', () => {
    const record = unwrapZohoRecord({ invoice_id: 'inv-2' }, 'invoices');
    assert.equal(record['invoice_id'], 'inv-2');
  });
});

describe('summarizeZohoWrite', () => {
  const draft = {
    invoice_id: '1500000000001',
    invoice_number: 'INV-000042',
    status: 'draft',
    total: '11800.00',
    balance: '11800.00',
    currency_code: 'INR',
  };

  it('says a draft is a draft instead of reporting it as issued', () => {
    const summary = summarizeZohoWrite({
      module: 'invoices',
      verb: 'created',
      record: draft,
      appBaseUrl: 'https://books.zoho.com',
      organizationId: 'org-9',
    });

    assert.match(summary.message, /INV-000042/);
    assert.match(summary.message, /status draft/);
    assert.match(summary.message, /still a draft/i);
    assert.match(summary.message, /nothing has been sent/i);
  });

  it('states that no file is attached when Zoho lists no documents', () => {
    const summary = summarizeZohoWrite({
      module: 'invoices', verb: 'created', record: draft,
      appBaseUrl: 'https://books.zoho.com',
    });
    assert.match(summary.message, /No file is attached/i);
  });

  it('names the attached documents when Zoho reports them', () => {
    const summary = summarizeZohoWrite({
      module: 'bills',
      verb: 'created',
      record: { bill_id: 'b1', bill_number: 'B-7', status: 'open', documents: [{ file_name: 'acme.pdf' }] },
      appBaseUrl: 'https://books.zoho.com',
    });
    assert.match(summary.message, /Attached: acme\.pdf/);
  });

  it('builds a record link only when the organisation is known', () => {
    const withOrg = summarizeZohoWrite({
      module: 'invoices', verb: 'created', record: draft,
      appBaseUrl: 'https://finance.example.com/', organizationId: 'org-9',
    });
    const withoutOrg = summarizeZohoWrite({
      module: 'invoices', verb: 'created', record: draft,
      appBaseUrl: 'https://finance.example.com',
    });

    assert.equal(withOrg.recordUrl, 'https://finance.example.com/app/org-9#/invoices/1500000000001');
    assert.equal(withoutOrg.recordUrl, undefined);
  });

  it('does not discuss attachments for records that cannot carry them', () => {
    const summary = summarizeZohoWrite({
      module: 'contacts',
      verb: 'created',
      record: { contact_id: 'c1', contact_name: 'Acme Ltd' },
      appBaseUrl: 'https://books.zoho.com',
    });
    assert.equal(/attach/i.test(summary.message), false);
  });
});

describe('attachedDocumentNames', () => {
  it('ignores malformed document entries rather than inventing filenames', () => {
    const names = attachedDocumentNames({
      documents: [{ file_name: 'a.pdf' }, { }, 'nonsense', { document_name: 'b.pdf' }],
    });
    assert.deepEqual(names, ['a.pdf', 'b.pdf']);
  });
});

describe('selectAttachment', () => {
  const row = (over: Partial<ConversationAttachmentRow>): ConversationAttachmentRow => ({
    companyId: 'co', userId: 'u', channel: 'lark', conversationKey: 'thread-1',
    chatId: 'chat-1', larkMessageId: 'om-1', larkFileKey: 'key-1',
    fileName: 'ACME Invoice.pdf', mimeType: 'application/pdf',
    receivedAt: new Date('2026-08-01T10:00:00Z'),
    ...over,
  });

  it('matches on the name regardless of case and stray spacing', () => {
    const found = selectAttachment([row({})], '  acme   invoice.pdf ');
    assert.equal(found.kind, 'found');
  });

  it('takes the most recent re-send of the same file', () => {
    const older = row({ larkFileKey: 'key-1', receivedAt: new Date('2026-08-01T10:00:00Z') });
    const newer = row({ larkFileKey: 'key-1', receivedAt: new Date('2026-08-02T10:00:00Z') });
    const found = selectAttachment([older, newer], 'ACME Invoice.pdf');
    assert.equal(found.kind, 'found');
    assert.equal(found.kind === 'found' && found.row.receivedAt.toISOString(), '2026-08-02T10:00:00.000Z');
  });

  it('refuses to choose between two different files sharing one name', () => {
    const a = row({ larkFileKey: 'key-1' });
    const b = row({ larkFileKey: 'key-2', receivedAt: new Date('2026-08-02T10:00:00Z') });
    const result = selectAttachment([a, b], 'ACME Invoice.pdf');
    assert.equal(result.kind, 'ambiguous');
  });

  it('reports what is available instead of guessing at a near match', () => {
    const result = selectAttachment([row({ fileName: 'ACME-4471.pdf' })], 'ACME-4472.pdf');
    assert.equal(result.kind, 'not_found');
    assert.deepEqual(result.kind === 'not_found' ? result.available : [], ['ACME-4471.pdf']);
  });
});

describe('attachment lookup scope', () => {
  it('finds a file the member sent in an earlier top-level group message', async () => {
    // The runtime thread key carries the id of the message that seeded the
    // thread, so a PDF posted alone and the instruction posted next are two
    // different threads. Keying the lookup on that would miss the exact case
    // this index exists for, so it keys on the chat and the sender instead.
    const pdfMessage = { chatId: 'oc-1', chatType: 'group', messageId: 'om-pdf', userExternalId: 'ou-1' };
    const askMessage = { chatId: 'oc-1', chatType: 'group', messageId: 'om-ask', userExternalId: 'ou-1' };
    assert.notEqual(
      conversationKeyForMessage(pdfMessage),
      conversationKeyForMessage(askMessage),
      'precondition: the two messages really do get different thread keys',
    );

    const queried: any[] = [];
    const service = new ConversationAttachmentService(
      {
        record: async () => {},
        listLive: async (input) => {
          queried.push(input);
          return [{
            companyId: 'co', userId: 'u', channel: 'lark',
            conversationKey: conversationKeyForMessage(pdfMessage),
            chatId: 'oc-1', larkMessageId: 'om-pdf', larkFileKey: 'key-1',
            fileName: 'ACME-4471.pdf', mimeType: 'application/pdf',
            receivedAt: new Date('2026-08-01T10:00:00Z'),
          }];
        },
      },
      { warn: () => {} } as any,
    );

    const found = await service.lookup({
      companyId: 'co', userId: 'u', channel: 'lark',
      chatId: 'oc-1', fileName: 'ACME-4471.pdf',
    });

    assert.equal(found.kind, 'found');
    assert.equal(queried[0].chatId, 'oc-1');
    assert.equal('conversationKey' in queried[0], false);
  });
});
