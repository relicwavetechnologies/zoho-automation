import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isGatewaySessionUsable,
  normalizeGatewaySessionStatus,
} from '../../src/domain/follow-ups/session-status.ts';

describe('normalizeGatewaySessionStatus', () => {
  it('does not read "disconnected" as connected', () => {
    // The bug this module exists for: "disconnected".includes("connect") is true,
    // so a naive check reports a dead handset as healthy.
    assert.equal(normalizeGatewaySessionStatus('disconnected'), 'disconnected');
    assert.equal(isGatewaySessionUsable('disconnected'), false);
  });

  it('does not read "connecting" as connected either', () => {
    assert.equal(normalizeGatewaySessionStatus('connecting'), 'pending');
    assert.equal(isGatewaySessionUsable('connecting'), false);
  });

  it('recognises the usable states', () => {
    for (const value of ['connected', 'CONNECTED', 'ready', 'authenticated', 'open', 'active']) {
      assert.equal(normalizeGatewaySessionStatus(value), 'linked', value);
      assert.equal(isGatewaySessionUsable(value), true, value);
    }
  });

  it('recognises the mid-link states', () => {
    for (const value of ['qr', 'awaiting_qr', 'pairing', 'scan_qr', 'starting', 'initializing']) {
      assert.equal(normalizeGatewaySessionStatus(value), 'pending', value);
    }
  });

  it('recognises the broken states', () => {
    for (const value of ['logged_out', 'logout', 'unpaired', 'closed', 'failed', 'expired', 'banned']) {
      assert.equal(normalizeGatewaySessionStatus(value), 'disconnected', value);
    }
  });

  it('treats unknown, empty and missing vocabulary as disconnected', () => {
    // Failing towards "dark" is the safe direction: a false alarm costs a glance,
    // a false all-clear costs a client's messages.
    for (const value of ['something_new', '', '   ', undefined, null]) {
      assert.equal(normalizeGatewaySessionStatus(value), 'disconnected', String(value));
    }
  });
});

describe("the gateway's documented statuses", () => {
  // Lifted verbatim from the gateway's own openapi.json (SessionResponseDto).
  // Pinned here so a version bump that changes the vocabulary fails a test
  // rather than silently reporting live handsets as dead.
  const GATEWAY_ENUM = {
    created: 'pending',
    initializing: 'pending',
    qr_ready: 'pending',
    authenticating: 'pending',
    ready: 'linked',
    disconnected: 'disconnected',
    action_required: 'disconnected',
    failed: 'disconnected',
  } as const;

  for (const [remote, expected] of Object.entries(GATEWAY_ENUM)) {
    it(`reads "${remote}" as ${expected}`, () => {
      assert.equal(normalizeGatewaySessionStatus(remote), expected);
    });
  }

  it('does not read a handset part-way through linking as dead', () => {
    // Both of these used to fall through to `disconnected`: "authenticating"
    // does not contain "authenticated", and "created" matched nothing at all.
    // A number mid-scan showed "Not connected" until it flipped to linked.
    assert.equal(normalizeGatewaySessionStatus('authenticating'), 'pending');
    assert.equal(normalizeGatewaySessionStatus('created'), 'pending');
  });

  it('accepts the gateway shouting', () => {
    assert.equal(normalizeGatewaySessionStatus('READY'), 'linked');
    assert.equal(normalizeGatewaySessionStatus('QR_READY'), 'pending');
  });
});
