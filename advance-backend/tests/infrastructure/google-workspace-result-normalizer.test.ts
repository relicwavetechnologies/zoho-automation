import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeGoogleWorkspaceResult } from '../../src/infrastructure/google/google-workspace-result-normalizer';

describe('normalizeGoogleWorkspaceResult', () => {
  it('adds stable spreadsheet identifiers without dropping the provider result', () => {
    const prose = 'Successfully created spreadsheet. ID: sheet_123-AbC | URL: https://docs.google.com/spreadsheets/d/sheet_123-AbC/edit?ouid=42 | Locale: en_US';
    assert.deepEqual(normalizeGoogleWorkspaceResult('create_spreadsheet', { result: prose }), {
      result: prose,
      spreadsheetId: 'sheet_123-AbC',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet_123-AbC/edit?ouid=42',
    });
  });

  it('adds structured Gmail search results', () => {
    const result = normalizeGoogleWorkspaceResult('search_gmail_messages', {
      result: [
        'Found 2 messages:',
        '',
        '  1. Message ID: message-1',
        '  Web Link: https://mail.google.com/mail/u/0/#all/message-1',
        '  Thread ID: thread-1',
        '',
        '  2. Message ID: message-2',
        '  Web Link: https://mail.google.com/mail/u/0/#all/message-2',
        '',
        "📄 PAGINATION: To get the next page, call search_gmail_messages again with page_token='next-page-2'",
      ].join('\n'),
    }, { page_size: 100 }) as Record<string, unknown>;

    assert.deepEqual(result.messageIds, ['message-1', 'message-2']);
    assert.deepEqual(result.messages, [
      {
        messageId: 'message-1',
        webLink: 'https://mail.google.com/mail/u/0/#all/message-1',
        threadId: 'thread-1',
      },
      {
        messageId: 'message-2',
        webLink: 'https://mail.google.com/mail/u/0/#all/message-2',
      },
    ]);
    assert.deepEqual(result.pagination, {
      providerReturnedMessages: 2,
      structuredMessages: 2,
      unstructuredMessages: 0,
      requestedPageSize: 100,
      hasNextPage: true,
      nextPageToken: 'next-page-2',
      nextPageInputField: 'page_token',
    });
  });

  it('returns an explicit empty Gmail page without inventing continuation', () => {
    const result = normalizeGoogleWorkspaceResult(
      'search_gmail_messages',
      { text: "No messages found for query: 'newer_than:7d'" },
      { page_size: 50 },
    ) as Record<string, unknown>;

    assert.deepEqual(result.messages, []);
    assert.deepEqual(result.messageIds, []);
    assert.deepEqual(result.pagination, {
      providerReturnedMessages: 0,
      structuredMessages: 0,
      unstructuredMessages: 0,
      requestedPageSize: 50,
      hasNextPage: false,
    });
  });

  it('blocks zero-skip success when Gmail reports more records than it can normalize', () => {
    const result = normalizeGoogleWorkspaceResult(
      'search_gmail_messages',
      {
        result: [
          'Found 2 messages:',
          '',
          '1. Message ID: message-1',
          'Web Link: https://mail.google.com/mail/u/0/#all/message-1',
        ].join('\n'),
      },
      { page_size: 100 },
    ) as Record<string, unknown>;

    assert.deepEqual(result.pagination, {
      providerReturnedMessages: 2,
      structuredMessages: 1,
      unstructuredMessages: 1,
      requestedPageSize: 100,
      hasNextPage: false,
    });
    assert.deepEqual((result.advisories as Array<Record<string, unknown>>).map(({ code }) => code), [
      'gmail_search_records_unstructured',
    ]);
  });

  it('adds structured metadata for Gmail message batches', () => {
    const result = normalizeGoogleWorkspaceResult('get_gmail_messages_content_batch', {
      result: [
        'Retrieved 2 messages:',
        '',
        'Message ID: message-1',
        'Subject: First lead',
        'From: Alice <alice@example.com>',
        'Date: Tue, 21 Jul 2026 09:00:00 +0000',
        'To: user@example.com',
        'Web Link: https://mail.google.com/mail/u/0/#all/message-1',
        '---',
        'Message ID: message-2',
        'Subject: Second lead',
        'From: Bob <bob@example.org>',
        'Date: Tue, 21 Jul 2026 10:00:00 +0000',
      ].join('\n'),
    }, { message_ids: ['message-1', 'message-2'] }) as Record<string, unknown>;

    assert.deepEqual(result.messages, [
      {
        messageId: 'message-1',
        subject: 'First lead',
        from: 'Alice <alice@example.com>',
        date: 'Tue, 21 Jul 2026 09:00:00 +0000',
        to: 'user@example.com',
        webLink: 'https://mail.google.com/mail/u/0/#all/message-1',
      },
      {
        messageId: 'message-2',
        subject: 'Second lead',
        from: 'Bob <bob@example.org>',
        date: 'Tue, 21 Jul 2026 10:00:00 +0000',
      },
    ]);
    assert.deepEqual(result.batch, {
      requestedMessages: 2,
      structuredMessages: 2,
      missingMessages: 0,
      missingMessageIds: [],
      complete: true,
    });
  });

  it('makes missing Gmail batch records explicit and completion-blocking', () => {
    const result = normalizeGoogleWorkspaceResult(
      'get_gmail_messages_content_batch',
      {
        result: [
          'Retrieved 1 message:',
          '',
          'Message ID: message-1',
          'Subject: First lead',
          'From: Alice <alice@example.com>',
          'Date: Tue, 21 Jul 2026 09:00:00 +0000',
        ].join('\n'),
      },
      { message_ids: ['message-1', 'message-2'] },
    ) as Record<string, unknown>;

    assert.deepEqual(result.batch, {
      requestedMessages: 2,
      structuredMessages: 1,
      missingMessages: 1,
      missingMessageIds: ['message-2'],
      complete: false,
    });
    assert.deepEqual((result.advisories as Array<Record<string, unknown>>).map(({ code }) => code), [
      'gmail_batch_records_missing',
    ]);
  });

  it('adds structured, bounded Sheet read evidence and verification advisories', () => {
    const prose = [
      "Successfully read 3 rows from range 'Leads!A1:C3' in spreadsheet sheet-123 for user@example.com:",
      "Row  1: ['Sender', 'Subject', 'Received']",
      "Row  2: ['Alice O\\'Connor <alice@example.com>', 'Lead, demo', '2026-07-22']",
      "Row  3: ['', 42, True]",
    ].join('\n');
    const result = normalizeGoogleWorkspaceResult(
      'read_sheet_values',
      { result: prose },
      { spreadsheet_id: 'sheet-123', range_name: 'Leads!A1:C3' },
    ) as Record<string, unknown>;

    assert.equal(result.spreadsheetId, 'sheet-123');
    assert.equal(result.range, 'Leads!A1:C3');
    assert.deepEqual(result.values, [
      ['Sender', 'Subject', 'Received'],
      ["Alice O'Connor <alice@example.com>", 'Lead, demo', '2026-07-22'],
      ['', 42, true],
    ]);
    assert.equal(result.rowCount, 3);
    assert.equal(result.returnedRowCount, 3);
    assert.equal(result.omittedRowCount, 0);
    assert.equal(result.columnCount, 3);
    assert.equal(result.isEmpty, false);
    assert.equal(result.complete, true);
    assert.deepEqual(result.advisories, [{
      code: 'verify_destination_write',
      level: 'required',
      instruction: 'Compare the returned header and final populated row with the intended write before reporting success.',
    }]);
  });

  it('makes the MCP 50-row display limit explicit instead of presenting a partial read as complete', () => {
    const visibleRows = Array.from(
      { length: 50 },
      (_, index) => `Row ${String(index + 1).padStart(2, ' ')}: ['row-${index + 1}']`,
    );
    const result = normalizeGoogleWorkspaceResult(
      'read_sheet_values',
      { text: [
        "Successfully read 75 rows from range 'Data!A1:A75' in spreadsheet sheet-456 for user@example.com:",
        ...visibleRows,
        '... and 25 more rows',
      ].join('\n') },
      { spreadsheet_id: 'sheet-456', range_name: 'Data!A1:A75' },
    ) as Record<string, unknown>;

    assert.equal((result.values as unknown[]).length, 50);
    assert.equal(result.rowCount, 75);
    assert.equal(result.returnedRowCount, 50);
    assert.equal(result.omittedRowCount, 25);
    assert.equal(result.complete, false);
    assert.deepEqual((result.advisories as Array<Record<string, unknown>>).map(({ code }) => code), [
      'verify_destination_write',
      'sheet_read_model_view_incomplete',
    ]);
  });

  it('normalizes an empty Sheet range as explicit verification evidence', () => {
    const result = normalizeGoogleWorkspaceResult(
      'read_sheet_values',
      { result: "No data found in range 'Sheet1!A1:C10' for user@example.com." },
      { spreadsheet_id: 'sheet-empty', range_name: 'Sheet1!A1:C10' },
    ) as Record<string, unknown>;

    assert.deepEqual(result.values, []);
    assert.equal(result.rowCount, 0);
    assert.equal(result.returnedRowCount, 0);
    assert.equal(result.isEmpty, true);
    assert.equal(result.complete, true);
  });
});
