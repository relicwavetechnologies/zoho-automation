import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  surfaceCapabilities,
  type SurfaceCapabilities,
} from '../../src/domain/channel/surface-capabilities.ts';
import { RUNTIME_CHANNELS } from '../../src/domain/channel/runtime-channel.ts';

/**
 * The property the whole design exists to make checkable.
 *
 * Level 1 is the strict form: the two surfaces are given identical capabilities,
 * so anything that differs between them is a bug rather than a decision. The
 * relaxed form — work identical, delivery may differ — is what this becomes at
 * level 2, and relaxing it should be a deliberate edit to this file that someone
 * has to read and agree with.
 */

/** Everything about a surface except which one it is. */
function withoutIdentity(caps: SurfaceCapabilities): Omit<SurfaceCapabilities, 'key'> {
  const { key: _key, ...rest } = caps;
  return rest;
}

describe('surface parity (level 1)', () => {
  const lark = surfaceCapabilities('lark');
  const web = surfaceCapabilities('web');

  // If turning "web may show artifacts" from off to on ever requires a code
  // change rather than a value change, the architecture was wrong — and this is
  // where that is meant to be found out, at the start of level 2 rather than
  // after level 2 has shipped.
  it('gives the web nothing Lark does not have, except how the log arrives', () => {
    assert.deepEqual(
      { ...withoutIdentity(web), worklog: lark.worklog },
      withoutIdentity(lark),
    );
  });

  // The one honest difference: a browser draws the log natively instead of
  // re-editing a card. It changes nothing the model decides.
  it('differs only in the work log, and says so out loud', () => {
    assert.equal(lark.worklog, 'patched-card');
    assert.equal(web.worklog, 'streamed');
  });

  it('has not quietly granted the web richer output ahead of level 2', () => {
    assert.equal(web.artifacts, 'none');
    assert.equal(web.charts, false);
    assert.equal(web.handoff, false);
  });

  // A surface the backend drives must publish limits, or the model is briefed on
  // nothing and goes back to guessing — the state this design replaced.
  it('publishes real limits for every surface it drives', () => {
    for (const channel of RUNTIME_CHANNELS) {
      const caps = surfaceCapabilities(channel);
      assert.equal(caps.key, channel);
      assert.ok(caps.maxBlockChars > 0, `${channel} maxBlockChars`);
      assert.ok(caps.maxMessageBytes > 0, `${channel} maxMessageBytes`);
      assert.ok(caps.tables.maxRows > 0, `${channel} tables.maxRows`);
      assert.ok(caps.tables.maxPerMessage > 0, `${channel} tables.maxPerMessage`);
    }
  });

  // Decision 2: more room to show, never more power to act. Nothing in the
  // descriptor may name a tool, a permission, or a capability grant.
  it('describes presentation only, never authority', () => {
    const fields = Object.keys(withoutIdentity(web));
    for (const field of fields) {
      assert.doesNotMatch(
        field,
        /permission|grant|tool|role|scope|allow/i,
        `"${field}" reads like authority, and a surface must never carry any`,
      );
    }
  });
});
