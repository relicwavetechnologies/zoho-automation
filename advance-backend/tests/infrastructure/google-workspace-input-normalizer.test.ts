import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeGoogleWorkspaceInput } from '../../src/infrastructure/google/google-workspace-input-normalizer.ts';

describe('Google Workspace input normalizer', () => {
  it('accepts the universal spelling of the Sheets range argument', () => {
    assert.deepEqual(
      normalizeGoogleWorkspaceInput('read_sheet_values', { spreadsheet_id: 's1', range: 'Export!A2:H305' }),
      { spreadsheet_id: 's1', range_name: 'Export!A2:H305' },
    );
    assert.deepEqual(
      normalizeGoogleWorkspaceInput('modify_sheet_values', { range: 'Sheet1!A1', values: [['x']] }),
      { range_name: 'Sheet1!A1', values: [['x']] },
    );
  });

  it('lets an explicit range_name win so nothing is silently rewritten', () => {
    assert.deepEqual(
      normalizeGoogleWorkspaceInput('read_sheet_values', { range: 'Wrong!A1', range_name: 'Right!A1' }),
      { range_name: 'Right!A1' },
    );
  });

  it('leaves every other tool and argument untouched', () => {
    const listInput = { range: 'not-a-sheet-range' };
    assert.equal(normalizeGoogleWorkspaceInput('list_spreadsheets', listInput), listInput);

    const noRange = { spreadsheet_id: 's1' };
    assert.equal(normalizeGoogleWorkspaceInput('read_sheet_values', noRange), noRange);
  });

  it('preserves an explicitly undefined range_name as the caller wrote it', () => {
    // `range_name: undefined` is not a supplied value, so the alias still fills it.
    assert.deepEqual(
      normalizeGoogleWorkspaceInput('read_sheet_values', { range: 'A1:B2', range_name: undefined }),
      { range_name: 'A1:B2' },
    );
  });
});
