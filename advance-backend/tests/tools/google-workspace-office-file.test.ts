import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withRecoveryHint } from '../../src/application/tools/families/google-workspace-mcp.tool.ts';

describe('withRecoveryHint', () => {
  it('tells the model how to recover from an Office-file refusal', () => {
    // Google's own wording, from a live read_sheet_values against an exported
    // .xlsx. Twice the model read this and reported missing Sheets scopes; the
    // grant contained auth/spreadsheets both times, so reconnecting was advice
    // that could only fail.
    const hinted = withRecoveryHint(
      'API error in read_sheet_values: HttpError 400 ... "This operation is not supported for this document. The document must not be an Office file."',
    );
    assert.match(hinted, /not a permission problem/);
    assert.match(hinted, /do not report missing scopes/);
    assert.match(hinted, /reconnect Google/);
    assert.match(hinted, /`resolve_reference` on the same URL/);
    // The provider's own words survive; the hint is added, never substituted.
    assert.match(hinted, /must not be an Office file/);
  });

  it('leaves every other provider failure exactly as Google reported it', () => {
    for (const message of [
      'HttpError 403: insufficient authentication scopes',
      'HttpError 404: File not found',
      'Error calling tool: quota exceeded',
    ]) {
      assert.equal(withRecoveryHint(message), message);
    }
  });
});
