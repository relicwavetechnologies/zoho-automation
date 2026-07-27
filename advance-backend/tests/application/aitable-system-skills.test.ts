import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aitableSkills } from '../../src/application/skills/aitable.skill.ts';
import { createDefaultSkillRegistry } from '../../src/application/skills/index.ts';
import { AITABLE_TOOL_IDS, aitableOperationNames } from '../../src/application/aitable/aitable-manifest.ts';
import { CANONICAL_TOOL_IDS, type CanonicalToolId } from '../../src/domain/tools/tool-id.ts';

const allInstructions = aitableSkills.map(skill => skill.instructions).join('\n');

describe('AITable system skills', () => {
  it('is registered in the default skill registry', () => {
    const registry = createDefaultSkillRegistry();
    for (const skill of aitableSkills) {
      assert.ok(registry.getById(skill.id), `${skill.id} should be registered`);
    }
  });

  it('only claims tools that exist in the canonical registry', () => {
    for (const skill of aitableSkills) {
      for (const toolId of skill.toolIds) {
        assert.ok(
          CANONICAL_TOOL_IDS.includes(toolId as CanonicalToolId),
          `${skill.id} claims unknown tool ${toolId}`,
        );
      }
    }
  });

  it('covers both AITable products', () => {
    const claimed = new Set(aitableSkills.flatMap(skill => skill.toolIds));
    for (const toolId of AITABLE_TOOL_IDS) {
      assert.ok(claimed.has(toolId), `no skill covers ${toolId}`);
    }
  });

  // The two integrations sit beside each other in the catalogue and are one
  // character apart, so the hazard is a model reaching for Airtable's concepts
  // here. Airtable is mentioned once, deliberately, to contrast the two filter
  // formats — that contrast is the point. What must never appear is Airtable's
  // identifiers or tool names, which would be actively wrong against Fusion.
  it('never borrows Airtable identifiers or tool names', () => {
    for (const term of ['baseId', 'tableId', 'app...', 'tbl...', 'fldXXX']) {
      assert.equal(allInstructions.includes(term), false, `${term} is Airtable vocabulary`);
    }
    for (const airtableTool of [
      'list_bases', 'search_bases', 'list_tables_for_base', 'get_table_schema',
      'list_records_for_table', 'create_records_for_table', 'update_records_for_table',
      'delete_records_for_table', 'revert_action', 'performUpsert', 'typecast',
    ]) {
      assert.equal(allInstructions.includes(airtableTool), false, `${airtableTool} is an Airtable tool`);
    }
  });

  it('mentions Airtable only to contrast the two filter formats', () => {
    const mentions = allInstructions.match(/airtable/gi) ?? [];
    // One contrast in the read guidance, plus the file header comment which is
    // not part of the instructions.
    assert.equal(mentions.length, 1, `expected a single deliberate contrast, found ${mentions.length}`);
    assert.match(allInstructions, /unlike Airtable's structured filter tree/);
  });

  // AITable filters with a formula string; Airtable takes a structured tree.
  // Getting this backwards produces silently unfiltered reads.
  it('tells the model AITable filters with a formula string', () => {
    assert.match(allInstructions, /filterByFormula/);
    assert.match(allInstructions, /do not send an object/i);
  });

  it('warns that a partial write must not be blindly retried', () => {
    assert.match(allInstructions, /aitable_partial_write/);
    assert.match(allInstructions, /duplicate rows/i);
  });

  // A revoked key fails identically forever, so retrying is pure waste and
  // reads to the member as an unexplained outage.
  it('tells the model what to do when the stored key was revoked', () => {
    assert.match(allInstructions, /aitable_key_needs_replacing/);
    assert.match(allInstructions, /do not retry/i);
  });

  it('never invites a member to paste an API key into chat', () => {
    assert.match(allInstructions, /never ask a member to paste one into chat/i);
  });

  // A skill that names an operation its own tools do not carry burns a turn on
  // a permission refusal every time the model follows the instruction. This
  // caught the Datasheets skill telling the model to call get_fields when only
  // the Fields tool had it.
  it('never instructs an operation its own tools do not have', () => {
    for (const skill of aitableSkills) {
      const available = new Set(skill.toolIds.flatMap(toolId => aitableOperationNames(toolId)));
      const everyKnownOperation = new Set(AITABLE_TOOL_IDS.flatMap(toolId => aitableOperationNames(toolId)));

      for (const named of skill.instructions.match(/\b[a-z]+_[a-z_]+\b/g) ?? []) {
        // Only assert on strings that are genuinely operation names; the
        // instructions also mention result codes such as aitable_partial_write.
        if (!everyKnownOperation.has(named)) continue;
        assert.ok(
          available.has(named),
          `${skill.id} instructs "${named}" but holds only ${skill.toolIds.join(', ')}`,
        );
      }
    }
  });

  it('states that a field cannot be edited, rather than implying delete-and-recreate', () => {
    assert.match(allInstructions, /no endpoint for editing an existing field/i);
    assert.match(allInstructions, /cannot be undone/i);
  });
});
