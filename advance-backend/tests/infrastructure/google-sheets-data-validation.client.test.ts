import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GOOGLE_SHEETS_DATA_VALIDATION_OPERATION,
  GoogleSheetsDataValidationClient,
  parseExplicitA1Range,
  type SheetsApiPort,
} from '../../src/infrastructure/google/google-sheets-data-validation.client';

describe('GoogleSheetsDataValidationClient', () => {
  it('converts explicit A1 target ranges to Google GridRange coordinates', () => {
    const sheets = new Map([['Project Plan', 42]]);
    assert.deepEqual(parseExplicitA1Range("'Project Plan'!D2:D100", sheets), {
      sheetId: 42,
      startColumnIndex: 3,
      startRowIndex: 1,
      endColumnIndex: 4,
      endRowIndex: 100,
    });
    assert.deepEqual(parseExplicitA1Range("'Project Plan'!D:D", sheets), {
      sheetId: 42,
      startColumnIndex: 3,
      endColumnIndex: 4,
    });
  });

  it('refuses ambiguous or unknown sheet ranges', () => {
    const sheets = new Map([['Sheet1', 0]]);
    assert.throws(() => parseExplicitA1Range('D2:D100', sheets), /explicit sheet name/);
    assert.throws(() => parseExplicitA1Range('Missing!D2:D100', sheets), /Unknown sheet/);
  });

  it('sets list dropdowns through one typed spreadsheets.batchUpdate request', async () => {
    const calls: any[] = [];
    const api: SheetsApiPort = {
      getSheetProperties: async () => [{ sheetId: 7, title: 'Sheet1' }],
      batchUpdate: async (spreadsheetId, requests) => {
        calls.push({ spreadsheetId, requests });
        return { replies: [{}] };
      },
    };
    const client = new GoogleSheetsDataValidationClient('unused-test-token', api);
    const result = await client.callTool(GOOGLE_SHEETS_DATA_VALIDATION_OPERATION, {
      spreadsheet_id: 'sheet-123',
      action: 'set',
      ranges: ['Sheet1!D2:D100'],
      rule: { type: 'one_of_list', values: ['Pending', 'Approved', 'Rejected'] },
      input_message: 'Choose a status',
    }) as any;

    assert.equal(result.url, 'https://docs.google.com/spreadsheets/d/sheet-123/edit');
    assert.deepEqual(calls, [{
      spreadsheetId: 'sheet-123',
      requests: [{
        setDataValidation: {
          range: {
            sheetId: 7,
            startColumnIndex: 3,
            startRowIndex: 1,
            endColumnIndex: 4,
            endRowIndex: 100,
          },
          rule: {
            condition: {
              type: 'ONE_OF_LIST',
              values: [
                { userEnteredValue: 'Pending' },
                { userEnteredValue: 'Approved' },
                { userEnteredValue: 'Rejected' },
              ],
            },
            strict: true,
            showCustomUi: true,
            inputMessage: 'Choose a status',
          },
        },
      }],
    }]);
  });

  it('removes validation by sending a null rule', async () => {
    let requests: readonly Record<string, unknown>[] = [];
    const api: SheetsApiPort = {
      getSheetProperties: async () => [{ sheetId: 0, title: 'Sheet1' }],
      batchUpdate: async (_spreadsheetId, nextRequests) => { requests = nextRequests; return {}; },
    };
    const client = new GoogleSheetsDataValidationClient('unused-test-token', api);
    await client.callTool(GOOGLE_SHEETS_DATA_VALIDATION_OPERATION, {
      spreadsheet_id: 'sheet-123',
      action: 'remove',
      ranges: ['Sheet1!A2:A'],
    });

    assert.equal((requests[0] as any).setDataValidation.rule, null);
  });

  it('requires a rule for set and rejects extra model arguments', async () => {
    const api: SheetsApiPort = {
      getSheetProperties: async () => [],
      batchUpdate: async () => ({}),
    };
    const client = new GoogleSheetsDataValidationClient('unused-test-token', api);
    await assert.rejects(
      () => client.callTool(GOOGLE_SHEETS_DATA_VALIDATION_OPERATION, {
        spreadsheet_id: 'sheet-123', action: 'set', ranges: ['Sheet1!A2:A'], guessed: true,
      }),
      /Unrecognized key|rule is required/,
    );
  });
});
