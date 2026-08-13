import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { issuePiRuntimeLease } from '../../src/application/runtime/pi-runtime-lease.ts';

function claims(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('Pi runtime lease', () => {
  const base = {
    channel: 'lark' as const,
    sessionId: 'session-1',
    userId: 'user-1',
    companyId: 'company-1',
    instanceId: 'pi-local-1',
    threadId: 'lark:chat-1',
  };

  it('carries the department the run was launched for', () => {
    // A member can belong to several departments; without this the container
    // takes the first one and executes under the wrong tool grants.
    const token = issuePiRuntimeLease({ ...base, departmentId: 'dept-finance' }, 'secret');
    assert.equal(claims(token)['departmentId'], 'dept-finance');
  });

  it('omits the department when the run has none, rather than inventing one', () => {
    const token = issuePiRuntimeLease(base, 'secret');
    assert.equal('departmentId' in claims(token), false);
  });

  it('carries the surface it was issued for, so a second one is not read as Lark', () => {
    // The middleware trusts this claim to decide which channel the run is on.
    // Hard-coding it here was what made "backend drove this run" and "this is
    // Lark" the same fact.
    assert.equal(claims(issuePiRuntimeLease({ ...base, channel: 'web' }, 'secret'))['channel'], 'web');
    assert.equal(claims(issuePiRuntimeLease(base, 'secret'))['channel'], 'lark');
  });
});
