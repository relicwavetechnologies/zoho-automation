import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleSheetReference } from '../../src/application/data-export/google-sheet-resource-reference.ts';

describe('Google Sheet reference', () => {
  it('parses supported Sheet URLs into one canonical reference', () => {
    const cases = [
      {
        input: 'https://docs.google.com/spreadsheets/d/1Ab_c-DeF/edit?usp=sharing#gid=123',
        subresourceId: '123',
      },
      {
        input: 'https://docs.google.com/spreadsheets/d/1Ab_c-DeF?gid=0',
        subresourceId: '0',
      },
      {
        input: ' https://docs.google.com/spreadsheets/d/1Ab_c-DeF/edit ',
        subresourceId: undefined,
      },
      {
        input: 'https://DOCS.GOOGLE.COM/spreadsheets/d/1Ab_c-DeF/edit?gid=7#gid=7',
        subresourceId: '7',
      },
    ] as const;

    for (const testCase of cases) {
      const result = parseGoogleSheetReference(testCase.input);
      assert.equal(result.ok, true);
      if (!result.ok) continue;
      assert.deepEqual(result.reference, {
        provider: 'google',
        kind: 'spreadsheet',
        resourceId: '1Ab_c-DeF',
        ...(testCase.subresourceId === undefined
          ? {}
          : { subresourceId: testCase.subresourceId }),
        canonicalUrl: `https://docs.google.com/spreadsheets/d/1Ab_c-DeF/edit${
          testCase.subresourceId === undefined ? '' : `#gid=${testCase.subresourceId}`
        }`,
      });
    }
  });

  it('rejects lookalike hosts, insecure URLs, credentials, ports, and Drive links', () => {
    const cases = [
      ['http://docs.google.com/spreadsheets/d/1Ab_c-DeF/edit', 'unsupported_protocol'],
      ['https://docs.google.com.evil.test/spreadsheets/d/1Ab_c-DeF/edit', 'unsupported_host'],
      ['https://user@docs.google.com/spreadsheets/d/1Ab_c-DeF/edit', 'unsupported_host'],
      ['https://docs.google.com:444/spreadsheets/d/1Ab_c-DeF/edit', 'unsupported_host'],
      ['https://drive.google.com/open?id=1Ab_c-DeF', 'unsupported_host'],
    ] as const;

    for (const [input, reason] of cases) {
      assert.deepEqual(parseGoogleSheetReference(input), { ok: false, reason });
    }
  });

  it('rejects unsupported paths, malformed IDs, and ambiguous or invalid gids', () => {
    const cases = [
      ['not a url', 'invalid_url'],
      ['https://docs.google.com/document/d/1Ab_c-DeF/edit', 'unsupported_path'],
      ['https://docs.google.com/spreadsheets/d/1Ab_c-DeF/copy', 'unsupported_path'],
      ['https://docs.google.com/spreadsheets/d/', 'unsupported_path'],
      ['https://docs.google.com/spreadsheets/d/bad%20id/edit', 'invalid_spreadsheet_id'],
      ['https://docs.google.com/spreadsheets/d/1Ab_c-DeF/edit#gid=-1', 'invalid_gid'],
      ['https://docs.google.com/spreadsheets/d/1Ab_c-DeF/edit#gid=abc', 'invalid_gid'],
      ['https://docs.google.com/spreadsheets/d/1Ab_c-DeF/edit?gid=1#gid=2', 'invalid_gid'],
      ['https://docs.google.com/spreadsheets/d/1Ab_c-DeF/edit?gid=1&gid=2', 'invalid_gid'],
      ['https://docs.google.com/spreadsheets/d/1Ab_c-DeF/edit#gid=9007199254740992', 'invalid_gid'],
    ] as const;

    for (const [input, reason] of cases) {
      assert.deepEqual(parseGoogleSheetReference(input), { ok: false, reason });
    }
  });
});
