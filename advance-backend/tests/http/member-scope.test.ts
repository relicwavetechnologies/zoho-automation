import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemberScope, type MemberAuthorization } from '../../src/http/member/member-scope';

/** Just enough of an Express response to record what a route answered. */
function fakeRes(locals: Record<string, unknown> = {}) {
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  return {
    locals,
    status(code: number) { sent.status = code; return this; },
    json(body: Record<string, unknown>) { sent.body = body; return this; },
    sent,
  };
}

const allowed = async (): Promise<MemberAuthorization> => ({ kind: 'allowed' });
const signedIn = { companyId: 'c1', userId: 'u1', aiRole: 'MEMBER' };

test('an unreachable database is 503, not "you have no department"', async () => {
  // The failure this exists for. The tunnel to the development database
  // dropped, this await rejected, the rejection escaped an async Express
  // handler — which Express 4 does not catch — and the whole backend exited.
  const scoped = createMemberScope({
    resolveDepartmentId: async () => {
      throw new Error('Timed out fetching a new connection from the connection pool');
    },
    featureName: 'Follow-ups',
    authorize: allowed,
  });

  const res = fakeRes(signedIn);
  // Resolves rather than throwing. That is the whole point: nothing above this
  // catches, so a rejection here is a dead process.
  const scope = await scoped(res as never, 'list');

  assert.equal(scope, null);
  assert.equal(res.sent.status, 503);
  assert.equal(res.sent.body?.code, 'scope_unavailable');
  // Never 409: telling somebody they are in no department when the database
  // blinked sends them to an administrator who finds nothing wrong.
  assert.notEqual(res.sent.status, 409);
});

test('a member genuinely in no department is 409, and says what to do', async () => {
  const scoped = createMemberScope({
    resolveDepartmentId: async () => null,
    featureName: 'Follow-ups',
    authorize: allowed,
  });

  const res = fakeRes(signedIn);
  assert.equal(await scoped(res as never, 'list'), null);
  assert.equal(res.sent.status, 409);
  assert.equal(res.sent.body?.code, 'no_active_department');
  assert.match(String(res.sent.body?.message), /Ask an admin/);
});

test('a refusal is 403 and carries the code the browser branches on', async () => {
  const scoped = createMemberScope({
    resolveDepartmentId: async () => 'd1',
    featureName: 'Follow-ups',
    authorize: async () => ({ kind: 'denied', message: 'You do not have permission.' }),
  });

  const res = fakeRes(signedIn);
  assert.equal(await scoped(res as never, 'sendBroadcast'), null);
  assert.equal(res.sent.status, 403);
  // `code`, not `error`. The browser's error reader only looks in `code`, and
  // these were sent as `error` — so every refusal arrived codeless and the web
  // shell reported it as a read that failed.
  assert.equal(res.sent.body?.code, 'not_permitted');
  assert.equal(res.sent.body?.message, 'You do not have permission.');
});

test('an unreadable permission store is 503, not a refusal', async () => {
  const scoped = createMemberScope({
    resolveDepartmentId: async () => 'd1',
    featureName: 'Follow-ups',
    authorize: async () => ({ kind: 'unavailable', message: 'Try again shortly.' }),
  });

  const res = fakeRes(signedIn);
  assert.equal(await scoped(res as never, 'list'), null);
  assert.equal(res.sent.status, 503);
  assert.equal(res.sent.body?.code, 'permission_unavailable');
});

test('a resolved caller carries the department the server chose, never one they named', async () => {
  const scoped = createMemberScope({
    resolveDepartmentId: async () => 'd1',
    featureName: 'Follow-ups',
    authorize: allowed,
  });

  const scope = await scoped(fakeRes(signedIn) as never, 'list');
  assert.deepEqual(scope, { companyId: 'c1', departmentId: 'd1', userId: 'u1' });
});

test('an unauthenticated caller never reaches the database', async () => {
  let looked = false;
  const scoped = createMemberScope({
    resolveDepartmentId: async () => { looked = true; return 'd1'; },
    featureName: 'Follow-ups',
    authorize: allowed,
  });

  const res = fakeRes({});
  assert.equal(await scoped(res as never, 'list'), null);
  assert.equal(res.sent.status, 401);
  assert.equal(looked, false);
});
