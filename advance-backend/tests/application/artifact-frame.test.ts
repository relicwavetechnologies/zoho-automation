import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseProgressEvent } from '../../src/application/runtime/lark-pi-runtime.service.ts';
import { createRunTimelineReducer } from '../../src/application/channels/run-timeline.reducer.ts';

/**
 * The artifact frame's trip from container to reader.
 *
 * Three things can go wrong here and none of them are visible in a screenshot:
 * an id that is really a file path reaching a URL, a saved document quietly
 * flipping the work log to "writing", and a malformed frame being repaired into
 * one that points at nothing.
 */

const good = {
  type: 'artifact',
  artifactId: 'q3-review-9f1c2a',
  title: 'Q3 review',
  mime: 'text/markdown',
  version: 3,
};

describe('artifact progress frame', () => {
  it('carries an address, and no body', () => {
    const parsed = parseProgressEvent(good);
    assert.deepEqual(parsed, good);
    // Whatever a container attaches, the body is not on this frame — it is
    // already stored, and a report on a progress frame is a report on a wire
    // sized for sentences.
    const withBody = parseProgressEvent({ ...good, body: '# a very long report' });
    assert.equal((withBody as Record<string, unknown> | undefined)?.['body'], undefined);
  });

  it('refuses an id that would not survive a URL', () => {
    for (const artifactId of ['../../etc/passwd', 'reports/q3.md', 'a b', '', '-leading-dash']) {
      assert.equal(
        parseProgressEvent({ ...good, artifactId }),
        undefined,
        `"${artifactId}" must be dropped, not repaired — a repaired id points at nothing`,
      );
    }
  });

  it('drops a frame missing the fields a reader needs', () => {
    assert.equal(parseProgressEvent({ ...good, title: '' }), undefined);
    assert.equal(parseProgressEvent({ ...good, mime: '' }), undefined);
  });

  it('falls back to a first version rather than a nonsensical one', () => {
    for (const version of [0, -4, 2.5, 'three', undefined]) {
      const parsed = parseProgressEvent({ ...good, version });
      assert.equal((parsed as { version?: number } | undefined)?.version, 1);
    }
  });

  it('leaves the work log where it was', () => {
    const timeline = createRunTimelineReducer({ startedAtMs: Date.now() });
    timeline.apply({ type: 'tool_start', callId: 'c1', toolName: 'write' });
    const working = timeline.timeline();

    timeline.apply(good as never);

    // The fall-through at the end of the reducer's chain treats an unknown frame
    // as the run starting to write. Saving a document mid-run would then tell the
    // reader the work had finished, every time.
    assert.deepEqual(timeline.timeline().state, working.state);
    assert.deepEqual(timeline.timeline().ledger, working.ledger);
  });
});
