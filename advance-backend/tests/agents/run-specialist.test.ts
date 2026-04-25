/**
 * Tests for the pure helper functions in run-specialist.ts.
 *
 * These functions are intentionally exported so they can be tested
 * without running a full plan→execute cycle.
 *
 * Covered:
 *   - deriveConfidence:    all-success / mixed / all-failed / no steps
 *   - deriveFailedToolIds: failed + permission_denied outcomes
 *   - deriveMissingToolIds: planned tool not in scoped set
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveConfidence,
  deriveFailedToolIds,
  deriveMissingToolIds,
} from '../../src/application/orchestration/agents/specialists/run-specialist.ts';
import { makeTool } from '../helpers/agent-mocks.ts';
import { asToolId } from '../../src/shared/ids.ts';
import type { StepResult } from '../../src/domain/orchestration/step-result.ts';
import type { ToolOutcome } from '../../src/domain/tools/tool-call.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStep(status: StepResult['status']): StepResult {
  return {
    stepId:       's1',
    agentId:      'a1',
    status,
    toolOutcomes: [],
    durationMs:   5,
  };
}

function makeOutcome(status: ToolOutcome['status'], toolId = 'larkTask'): ToolOutcome {
  return {
    toolId:     asToolId(toolId),
    action:     'read' as any,
    status,
    data:       null,
    durationMs: 5,
  };
}

// ─── deriveConfidence ─────────────────────────────────────────────────────────

describe('deriveConfidence', () => {
  it("returns 'none' when no steps ran", () => {
    assert.equal(deriveConfidence([]), 'none');
  });

  it("returns 'high' when all steps succeeded", () => {
    assert.equal(deriveConfidence([makeStep('success'), makeStep('success')]), 'high');
  });

  it("treats 'partial' step as success (has data)", () => {
    assert.equal(deriveConfidence([makeStep('partial'), makeStep('success')]), 'high');
  });

  it("returns 'partial' when some succeeded and some failed", () => {
    assert.equal(deriveConfidence([makeStep('success'), makeStep('failed')]), 'partial');
  });

  it("returns 'none' when all steps failed", () => {
    assert.equal(deriveConfidence([makeStep('failed'), makeStep('failed')]), 'none');
  });

  it("returns 'none' when only skipped steps", () => {
    assert.equal(deriveConfidence([makeStep('skipped')]), 'none');
  });

  it("returns 'none' when mix of failed and skipped (no success)", () => {
    assert.equal(deriveConfidence([makeStep('failed'), makeStep('skipped')]), 'none');
  });
});

// ─── deriveFailedToolIds ──────────────────────────────────────────────────────

describe('deriveFailedToolIds', () => {
  it('returns empty array when all outcomes succeeded', () => {
    const outcomes = [makeOutcome('success', 'larkTask'), makeOutcome('success', 'larkMessaging')];
    assert.deepEqual(deriveFailedToolIds(outcomes), []);
  });

  it('includes tool IDs with failed status', () => {
    const outcomes = [makeOutcome('failed', 'larkTask'), makeOutcome('success', 'larkMessaging')];
    const result = deriveFailedToolIds(outcomes);
    assert.ok(result.includes('larkTask'));
    assert.ok(!result.includes('larkMessaging'));
  });

  it('includes tool IDs with permission_denied status', () => {
    const outcomes = [makeOutcome('permission_denied', 'googleGmail')];
    const result = deriveFailedToolIds(outcomes);
    assert.ok(result.includes('googleGmail'));
  });

  it('deduplicates — same tool failing multiple times appears once', () => {
    const outcomes = [makeOutcome('failed', 'larkTask'), makeOutcome('failed', 'larkTask')];
    assert.equal(deriveFailedToolIds(outcomes).length, 1);
  });

  it('handles empty outcomes array', () => {
    assert.deepEqual(deriveFailedToolIds([]), []);
  });
});

// ─── deriveMissingToolIds ─────────────────────────────────────────────────────

describe('deriveMissingToolIds', () => {
  it('returns empty array when all planned tools are in scope', () => {
    const scoped = [makeTool('larkTask'), makeTool('larkMessaging')];
    assert.deepEqual(deriveMissingToolIds(['larkTask', 'larkMessaging'], scoped), []);
  });

  it('returns tools referenced in plan but absent from scoped set', () => {
    const scoped = [makeTool('larkTask')];
    const missing = deriveMissingToolIds(['larkTask', 'googleGmail'], scoped);
    assert.ok(missing.includes('googleGmail'));
    assert.ok(!missing.includes('larkTask'));
  });

  it('deduplicates missing tools', () => {
    const scoped = [makeTool('larkTask')];
    const missing = deriveMissingToolIds(['googleGmail', 'googleGmail', 'googleDrive'], scoped);
    assert.ok(missing.includes('googleGmail'));
    assert.ok(missing.includes('googleDrive'));
    assert.equal(missing.filter(id => id === 'googleGmail').length, 1); // deduplicated
  });

  it('returns empty when planned tools list is empty', () => {
    const scoped = [makeTool('larkTask')];
    assert.deepEqual(deriveMissingToolIds([], scoped), []);
  });

  it('returns all planned tools as missing when scope is empty', () => {
    const missing = deriveMissingToolIds(['larkTask', 'larkMessaging'], []);
    assert.deepEqual(missing.sort(), ['larkMessaging', 'larkTask'].sort());
  });
});
