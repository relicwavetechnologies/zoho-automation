import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  IntegrationConnectionRepository,
  CONNECTION_NEEDS_KEY,
  apiKeyFingerprint,
} from '../../src/infrastructure/persistence/integration-connection.repository.ts';

const env = { ZOHO_TOKEN_ENCRYPTION_KEY: '0'.repeat(64) } as never;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'conn-1',
  companyId: 'co-1',
  provider: 'aitable',
  ownerType: 'user',
  ownerUserId: 'user-1',
  label: 'Growth',
  accountEmail: null,
  accountName: 'Growth',
  externalAccountId: 'fp',
  status: 'connected',
  scopes: [] as string[],
  accessTokenEncrypted: null,
  refreshTokenEncrypted: null,
  tokenType: 'api_key',
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  tokenMetadata: null,
  connectedAt: new Date('2026-07-01T00:00:00.000Z'),
  lastUsedAt: null,
  revokedAt: null,
  grants: [] as unknown[],
  ...over,
});

/** Enough of Prisma for the AITable paths, recording what they were asked to do. */
function fakeDb(over: Record<string, unknown> = {}) {
  const calls: { findMany?: any; findFirst?: any; upsert?: any; updateMany?: any[] } = { updateMany: [] };
  const db = {
    departmentMembership: { findMany: async () => [] },
    adminMembership: { findFirst: async () => null },
    integrationConnection: {
      findMany: async (input: unknown) => { calls.findMany = input; return [row()]; },
      findFirst: async (input: unknown) => { calls.findFirst = input; return row(); },
      upsert: async (input: unknown) => { calls.upsert = input; return row(); },
      updateMany: async (input: unknown) => { calls.updateMany!.push(input); return { count: 1 }; },
      update: async () => row(),
      ...(over['integrationConnection'] as object ?? {}),
    },
    integrationConnectionGrant: {
      findFirst: async () => null,
      create: async () => ({ id: 'grant-1' }),
      update: async () => ({ id: 'grant-1' }),
      upsert: async () => ({ id: 'grant-1' }),
    },
  };
  return { db, calls };
}

const repo = (db: unknown) => new IntegrationConnectionRepository(db as never, env);

describe('AITable connection persistence', () => {
  it('lists connections whose key has died alongside the live ones', async () => {
    const { db, calls } = fakeDb();
    await repo(db).listAccessibleAitableConnections({ companyId: 'co-1', userId: 'user-1' });

    // The query must not restrict to 'connected'. A dead key that vanished from
    // the list would leave its owner with a failing tool and nothing to repair.
    assert.deepEqual(calls.findMany.where.status, { in: ['connected', CONNECTION_NEEDS_KEY] });
    assert.equal(calls.findMany.where.provider, 'aitable');
  });

  it('carries the status through, so callers can tell a dead key apart', async () => {
    const { db } = fakeDb({
      integrationConnection: { findMany: async () => [row({ status: CONNECTION_NEEDS_KEY })] },
    });
    const result = await repo(db).listAccessibleAitableConnections({ companyId: 'co-1', userId: 'user-1' });

    assert.ok(result.ok);
    assert.equal(result.value[0]?.status, CONNECTION_NEEDS_KEY);
  });

  // Listable and usable are different questions. findAccessible resolves a
  // connection for a real call, so it must refuse one that cannot serve it.
  it('refuses to resolve a connection that needs a new key', async () => {
    const { db } = fakeDb({
      integrationConnection: {
        findMany: async () => [row({ status: CONNECTION_NEEDS_KEY })],
        findFirst: async (input: any) => (input.where.status === 'connected' ? null : row()),
      },
    });
    const result = await repo(db).findAccessibleAitableConnection({
      companyId: 'co-1', userId: 'user-1', connectionId: 'conn-1', minimumAccess: 'read_only',
    });

    assert.ok(result.ok);
    assert.equal(result.value, null);
  });

  it('stores the key encrypted, with nothing to refresh and no invented scopes', async () => {
    const { db, calls } = fakeDb();
    await repo(db).upsertAitableConnection({
      companyId: 'co-1', ownerType: 'user', ownerUserId: 'user-1',
      apiKey: 'usk_secret', spaces: [{ id: 'spc1', name: 'Growth' }],
    });

    const created = calls.upsert.create;
    assert.equal(created.tokenType, 'api_key');
    assert.equal(created.refreshTokenEncrypted, null, 'there is no refresh token to hold');
    assert.equal(created.accessTokenExpiresAt, null, 'a key does not expire on a schedule');
    // An invented scope string would be read as a capability claim by every
    // scope-group check downstream.
    assert.deepEqual(created.scopes, []);
    assert.ok(created.accessTokenEncrypted, 'the key must be stored');
    assert.equal(
      String(created.accessTokenEncrypted).includes('usk_secret'), false,
      'the raw key must never be written in the clear',
    );
  });

  it('identifies a connection by a hash of the key, never the key itself', async () => {
    const { db, calls } = fakeDb();
    await repo(db).upsertAitableConnection({
      companyId: 'co-1', ownerType: 'user', ownerUserId: 'user-1',
      apiKey: 'usk_secret', spaces: [{ id: 'spc1', name: 'Growth' }],
    });

    assert.equal(calls.upsert.create.externalAccountId, apiKeyFingerprint('usk_secret'));
    assert.equal(String(calls.upsert.where.companyId_dedupeKey.dedupeKey).includes('usk_secret'), false);
  });

  // Re-pasting the same key is an update of one row, not a second connection.
  it('lands the same key on the same row twice', async () => {
    const { db, calls } = fakeDb();
    const args = {
      companyId: 'co-1', ownerType: 'user' as const, ownerUserId: 'user-1',
      apiKey: '  usk_secret  ', spaces: [{ id: 'spc1', name: 'Growth' }],
    };
    await repo(db).upsertAitableConnection(args);
    const first = calls.upsert.where.companyId_dedupeKey.dedupeKey;
    await repo(db).upsertAitableConnection({ ...args, apiKey: 'usk_secret' });

    assert.equal(calls.upsert.where.companyId_dedupeKey.dedupeKey, first, 'whitespace must not fork the row');
  });

  // Several keys per company is expected, so identical labels would make the
  // account picker useless. The workspace name is the only thing AITable gives
  // us that tells two keys apart.
  it('names a connection after the workspace it reaches', async () => {
    const { db, calls } = fakeDb();
    await repo(db).upsertAitableConnection({
      companyId: 'co-1', ownerType: 'user', ownerUserId: 'user-1',
      apiKey: 'usk_a', spaces: [{ id: 'spc1', name: 'Finance' }],
    });

    assert.equal(calls.upsert.create.label, 'Finance');
    assert.equal(calls.upsert.create.accountName, 'Finance');
  });

  it('falls back to a generic label when the key reaches no workspace', async () => {
    const { db, calls } = fakeDb();
    await repo(db).upsertAitableConnection({
      companyId: 'co-1', ownerType: 'user', ownerUserId: 'user-1', apiKey: 'usk_a', spaces: [],
    });

    assert.equal(calls.upsert.create.label, 'AITable connection');
  });

  it('marks only a live connection as needing a key', async () => {
    const { db, calls } = fakeDb();
    await repo(db).markAitableConnectionNeedsKey({ companyId: 'co-1', connectionId: 'conn-1' });

    const [update] = calls.updateMany!;
    assert.equal(update.data.status, CONNECTION_NEEDS_KEY);
    // Scoped to 'connected' so a repair racing an in-flight call cannot be
    // undone by the loser.
    assert.equal(update.where.status, 'connected');
    assert.equal(update.where.provider, 'aitable');
  });

  // Rotating in place is what keeps grants and governance attached. Delete and
  // re-add would silently drop who the connection was shared with.
  it('rotates a key in place and brings the connection back to life', async () => {
    const { db, calls } = fakeDb();
    const replaced = await repo(db).replaceAitableApiKey({
      companyId: 'co-1', connectionId: 'conn-1',
      apiKey: 'usk_new', spaces: [{ id: 'spc1', name: 'Growth' }],
    });

    assert.ok(replaced.ok && replaced.value);
    const [update] = calls.updateMany!;
    assert.equal(update.data.status, 'connected', 'a repaired connection is usable again');
    assert.equal(update.data.externalAccountId, apiKeyFingerprint('usk_new'));
    // The row is located first, and that lookup is what accepts a connection
    // whose key had died — otherwise the repair path could not reach it.
    assert.deepEqual(calls.findFirst.where.status, { in: ['connected', CONNECTION_NEEDS_KEY] });
  });

  // The row is identified by its key, so rotating the key must move the dedupe
  // identity with it. Leaving the old fingerprint behind meant the next Add
  // Connection with the same new key missed this row and created a second one
  // holding the same credential.
  it('moves the dedupe identity when the key is rotated', async () => {
    const { db, calls } = fakeDb();
    await repo(db).upsertAitableConnection({
      companyId: 'co-1', ownerType: 'user', ownerUserId: 'user-1',
      apiKey: 'usk_new', spaces: [{ id: 'spc1', name: 'Growth' }],
    });
    const dedupeAfterUpsert = calls.upsert.where.companyId_dedupeKey.dedupeKey;

    await repo(db).replaceAitableApiKey({
      companyId: 'co-1', connectionId: 'conn-1',
      apiKey: 'usk_new', spaces: [{ id: 'spc1', name: 'Growth' }],
    });

    const [rotation] = calls.updateMany!;
    assert.equal(
      rotation.data.dedupeKey, dedupeAfterUpsert,
      're-pasting the rotated key must land on the same row, not fork a duplicate',
    );
  });

  it('follows the workspace name on rotation, but never overwrites a chosen label', async () => {
    const derived = fakeDb({
      integrationConnection: { findFirst: async () => row({ label: 'Growth', accountName: 'Growth' }) },
    });
    await repo(derived.db).replaceAitableApiKey({
      companyId: 'co-1', connectionId: 'conn-1', apiKey: 'usk_new',
      spaces: [{ id: 'spc2', name: 'Finance' }],
    });
    assert.equal(derived.calls.updateMany![0].data.label, 'Finance');

    const chosen = fakeDb({
      integrationConnection: { findFirst: async () => row({ label: 'My finance key', accountName: 'Growth' }) },
    });
    await repo(chosen.db).replaceAitableApiKey({
      companyId: 'co-1', connectionId: 'conn-1', apiKey: 'usk_new',
      spaces: [{ id: 'spc2', name: 'Finance' }],
    });
    assert.equal(chosen.calls.updateMany![0].data.label, undefined, 'a label someone typed is theirs to keep');
    assert.equal(chosen.calls.updateMany![0].data.accountName, 'Finance');
  });

  it('reports a rotation that matched nothing rather than claiming success', async () => {
    const { db } = fakeDb({
      integrationConnection: { updateMany: async () => ({ count: 0 }) },
    });
    const replaced = await repo(db).replaceAitableApiKey({
      companyId: 'co-1', connectionId: 'missing', apiKey: 'usk_new', spaces: [],
    });

    assert.ok(replaced.ok);
    assert.equal(replaced.value, false);
  });
});
