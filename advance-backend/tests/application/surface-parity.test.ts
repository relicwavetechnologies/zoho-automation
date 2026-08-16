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
 * It began as strict parity: the two surfaces were given identical capabilities,
 * so anything differing between them was a bug rather than a decision. The web
 * has since been granted more, and this file is where that stops being silent —
 * every grant is named here, one at a time, and a value that drifts without an
 * edit to this list fails.
 *
 * The test that matters is not "are they the same". It is **"is the difference
 * exactly the difference we meant"**, which is why the grants are enumerated
 * rather than the comparison loosened.
 */

/** Everything about a surface except which one it is. */
function withoutIdentity(caps: SurfaceCapabilities): Omit<SurfaceCapabilities, 'key'> {
  const { key: _key, ...rest } = caps;
  return rest;
}

/**
 * Every field on which the web is deliberately ahead of Lark, and the renderer
 * that earns each one.
 *
 * A field may only appear here once something in the browser actually draws it.
 * That is the whole discipline: the record is what the model is told, so an
 * entry with no renderer behind it is a promise made to the model that the
 * reader never sees kept.
 */
const WEB_GRANTS = {
  /** A browser draws the log natively instead of re-editing a card. */
  worklog: 'streamed',
  /** The panel beside the thread renders a stored document. */
  artifacts: 'inline',
} as const satisfies Partial<SurfaceCapabilities>;

describe('surface capabilities', () => {
  const lark = surfaceCapabilities('lark');
  const web = surfaceCapabilities('web');

  // If granting the web something ever requires a code change rather than a
  // value change, the architecture was wrong — and this is where that is meant
  // to be found out.
  it('gives the web nothing beyond its enumerated grants', () => {
    assert.deepEqual(
      { ...withoutIdentity(web), ...pick(lark, WEB_GRANTS) },
      withoutIdentity(lark),
    );
  });

  it('actually holds every grant it claims', () => {
    for (const [field, value] of Object.entries(WEB_GRANTS)) {
      assert.equal(
        web[field as keyof SurfaceCapabilities],
        value,
        `web.${field} is listed as a grant but does not hold it`,
      );
    }
  });

  // Lark keeps the conservative side of every grant. Its reader is a chat card:
  // it cannot open a document, and the model must never be told otherwise.
  it('grants Lark none of them', () => {
    assert.equal(lark.worklog, 'patched-card');
    assert.equal(lark.artifacts, 'none');
  });

  // Not yet granted, and each for a stated reason: no chart renders in the web
  // thread, and handoff would offer a move to a surface that is already this one.
  it('has not quietly granted what has no renderer behind it', () => {
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

/** The listed fields, read off the surface that has *not* been granted them. */
function pick(
  caps: SurfaceCapabilities,
  fields: Record<string, unknown>,
): Partial<SurfaceCapabilities> {
  const out: Record<string, unknown> = {};
  for (const field of Object.keys(fields)) out[field] = caps[field as keyof SurfaceCapabilities];
  return out as Partial<SurfaceCapabilities>;
}
