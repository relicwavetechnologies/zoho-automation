import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildGeneratedNativeToolSpecs,
  renderGeneratedNativeToolFiles,
} from '../../scripts/generate-pi-native-tools';
import { CANONICAL_TOOL_IDS } from '../../src/domain/tools/tool-id';
import { GENERATED_NATIVE_TOOL_SPECS } from '../../../divo-pi/divo/extensions/divo-gateway/native-tools/generated/index.ts';

describe('complete Pi-native tool catalogue parity', () => {
  it('matches every non-Semrush backend contract exactly', () => {
    const byToolId = <T extends { readonly toolId: string }>(specs: readonly T[]) =>
      [...specs].sort((left, right) => left.toolId.localeCompare(right.toolId));
    assert.deepEqual(
      byToolId(GENERATED_NATIVE_TOOL_SPECS),
      byToolId(buildGeneratedNativeToolSpecs()),
    );
  });

  it('covers every canonical tool exactly once with the hand-authored Semrush contract', () => {
    const toolIds = [...GENERATED_NATIVE_TOOL_SPECS.map(spec => spec.toolId), 'semrush'];
    assert.equal(new Set(toolIds).size, toolIds.length);
    assert.deepEqual([...toolIds].sort(), [...CANONICAL_TOOL_IDS].sort());
  });

  it('renders the committed family catalogue deterministically', () => {
    const files = renderGeneratedNativeToolFiles();
    assert.equal(files.size, 13);
    assert.ok(files.has('index.ts'));
    assert.ok(files.has('google.ts'));
    assert.ok(files.has('zoho.ts'));
  });
});
