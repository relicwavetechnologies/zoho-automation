import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isInternalHistoryMarker } from '../../src/domain/conversation/internal-history-marker.ts';

describe('isInternalHistoryMarker', () => {
  it('recognizes legacy called markers regardless of surrounding whitespace', () => {
    assert.equal(isInternalHistoryMarker(' [Called: agent_context_agent] '), true);
    assert.equal(isInternalHistoryMarker('[Called: agent_lark_ops, agent_google_ops]'), true);
  });

  it('does not reject legitimate user-facing bracketed text', () => {
    assert.equal(isInternalHistoryMarker('[Research complete]'), false);
    assert.equal(isInternalHistoryMarker('I called the context agent.'), false);
  });
});
