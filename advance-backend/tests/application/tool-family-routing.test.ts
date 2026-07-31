/**
 * Salvaged from the Lark/gateway work-bootstrap parity suite when the in-backend
 * supervisor was deleted. These three assertions never depended on the
 * supervisor — they cover the family routing metadata and the startup
 * reconciliation the container runtime still relies on — so they outlive it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  TOOL_FAMILY_DEFINITIONS,
  TOOL_FAMILY_IDS,
  toolFamiliesForQuery,
} from '../../src/domain/tools/tool-id';
import { createAirtableMcpTools } from '../../src/application/tools/families/airtable-mcp.tool';

describe('canonical family routing metadata', () => {
  it('reconciles capabilities before both local and production startup', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };

    assert.equal(packageJson.scripts?.predev, 'pnpm capabilities:reconcile');
    assert.equal(packageJson.scripts?.prestart, 'pnpm capabilities:reconcile');
  });

  it('recognizes every configured provider alias without provider-specific branches', () => {
    for (const family of TOOL_FAMILY_IDS) {
      for (const alias of TOOL_FAMILY_DEFINITIONS[family].routingAliases) {
        assert.ok(
          toolFamiliesForQuery(`Use ${alias} for this work`).includes(family),
          `${alias} should route to ${family}`,
        );
      }
    }
  });

  it('does not tell backend channels to omit a required Airtable connection ID', () => {
    const [tool] = createAirtableMcpTools({
      getConnection: async () => ({ status: 'unavailable' }),
    });

    assert.match(tool!.parameterDocs, /connectionId: required for call/);
    assert.doesNotMatch(tool!.parameterDocs, /backend selects only one eligible account/);
  });
});
