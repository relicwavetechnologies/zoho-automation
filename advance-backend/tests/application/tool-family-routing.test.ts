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

  it('refreshes file-delivery instructions during startup reconciliation', () => {
    const reconciler = readFileSync(
      new URL('../../scripts/reconcile-capabilities.ts', import.meta.url),
      'utf8',
    );

    assert.match(reconciler, /provisionFilesAndDocumentsForExistingCompanies\(prisma\)/);
    assert.match(reconciler, /provisionDivoLocalPythonForExistingCompanies\(prisma\)/);
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

  it('lets backend channels omit Airtable connection ID when one account is eligible', () => {
    const [tool] = createAirtableMcpTools({
      getConnection: async () => ({ status: 'unavailable' }),
    });

    assert.match(tool!.parameterDocs, /connectionId: optional unless the user selected an account/);
    assert.match(tool!.parameterDocs, /Divo selects the only account eligible/);
    assert.match(tool!.parameterDocs, /never send identity, token, or API-key fields/i);
  });
});
