import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { typedToolName } from '../../../divo-pi/divo/extensions/divo-gateway/typed-tools.ts';
import { CANONICAL_TOOL_IDS } from '../../src/domain/tools/tool-id.ts';

type RuntimeManifest = {
  toolAllowlist?: unknown;
};

const runtimeManifest = JSON.parse(
  readFileSync(
    new URL('../../../divo-pi/divo/runtime-manifest.json', import.meta.url),
    'utf8',
  ),
) as RuntimeManifest;

describe('Cloud Pi governed tool allowlist parity', () => {
  it('admits every canonical backend tool under its exact typed Pi name', () => {
    assert.ok(Array.isArray(runtimeManifest.toolAllowlist));
    assert.ok(runtimeManifest.toolAllowlist.every(value => typeof value === 'string'));

    const allowlist = runtimeManifest.toolAllowlist as string[];
    const typedNames = CANONICAL_TOOL_IDS.map(typedToolName);

    assert.equal(
      new Set(typedNames).size,
      typedNames.length,
      'canonical backend tool IDs must not collide after typed Pi name conversion',
    );
    assert.deepEqual(
      typedNames.filter(name => !allowlist.includes(name)),
      [],
      'a canonical backend tool is missing from Cloud Pi runtime-manifest.json',
    );
  });

  it('does not carry duplicate Pi tool names in the packaged allowlist', () => {
    assert.ok(Array.isArray(runtimeManifest.toolAllowlist));
    const allowlist = runtimeManifest.toolAllowlist as unknown[];
    assert.equal(
      new Set(allowlist).size,
      allowlist.length,
      'duplicate allowlist entries make the intended active Pi surface ambiguous',
    );
  });
});
