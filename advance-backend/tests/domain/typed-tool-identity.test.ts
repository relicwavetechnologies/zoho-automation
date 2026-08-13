import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_TOOL_IDS,
  canonicalToolIdForToolName,
  typedToolNameFor,
} from '../../src/domain/tools/tool-id.ts';
import { toolLabel } from '../../src/domain/tools/tool-labels.ts';

/*
 * Every governed capability is its own typed tool inside the container now that
 * the single `divo_gateway` is gone, so the tool's name is the only identity a
 * run carries. Unresolved, a real Gmail call reached the reader as
 * `Google gmail · call` with no vendor mark — the name spelled out with spaces
 * in it, because the table that knows the product is keyed by canonical id.
 */
describe('recovering a tool id from the name the container ran', () => {
  /* These four names are the ones divo-pi's own `typedToolName` tests pin, so
     the two sides hold the same literals: the naming transform is duplicated
     across two packages that ship separately, and a change to either that the
     other did not follow fails here rather than in a run. */
  it('names the tool the way the product does', () => {
    assert.equal(canonicalToolIdForToolName('divo_zoho_books'), 'zohoBooks');
    assert.equal(canonicalToolIdForToolName('divo_oms_site_data'), 'omsSiteData');
    assert.equal(canonicalToolIdForToolName('divo_web_search'), 'webSearch');
    assert.equal(canonicalToolIdForToolName('divo_knowledge'), 'knowledge');
    // The end of the chain, which is what the reader actually sees.
    assert.equal(canonicalToolIdForToolName('divo_google_gmail'), 'googleGmail');
    assert.equal(toolLabel(canonicalToolIdForToolName('divo_google_gmail')!).name, 'Gmail');
  });

  /* The lowercasing that produces the container name is lossy, so this is a
     table of the ids we have rather than an attempt to invert it. Building it
     from CANONICAL_TOOL_IDS is what keeps a newly added tool from being the one
     that silently falls back to a humanised name. */
  it('resolves every governed tool, with no two sharing a name', () => {
    const names = new Set<string>();
    for (const toolId of CANONICAL_TOOL_IDS) {
      const name = typedToolNameFor(toolId);
      assert.equal(canonicalToolIdForToolName(name), toolId, name);
      names.add(name);
    }
    assert.equal(names.size, CANONICAL_TOOL_IDS.length);
  });

  /* A `divo_` tool this backend does not govern is Pi's own — a skill loader, a
     todo list. Deriving an id from its name would put a vendor's mark beside
     something that is not that vendor, which is worse than the generic one. */
  it('refuses to name a tool it does not govern', () => {
    assert.equal(canonicalToolIdForToolName('divo_todos'), undefined);
    assert.equal(canonicalToolIdForToolName('divo_skill_view'), undefined);
    assert.equal(canonicalToolIdForToolName('divo_subagents'), undefined);
    assert.equal(canonicalToolIdForToolName('bash'), undefined);
    assert.equal(canonicalToolIdForToolName('divo_'), undefined);
  });
});
