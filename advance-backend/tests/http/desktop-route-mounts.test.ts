import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Where each desktop router is mounted.
 *
 * These prefixes are not interchangeable and not guessable: the desktop's
 * `divo_desktop_json_request` prefixes `/api/desktop/auth` onto every tool
 * path, while its department and approval calls use `/api/desktop`. Moving a
 * router between the two takes its endpoints off the air, and the desktop reads
 * the resulting 401 as an expired session — the symptom is members being signed
 * out seconds after signing in.
 *
 * The router tests exercise routers in isolation, so none of them can see a
 * wrong prefix here. This one can.
 */
const server = readFileSync(fileURLToPath(new URL('../../src/server.ts', import.meta.url)), 'utf-8');

function mountedPaths(): Map<string, string[]> {
  const mounts = new Map<string, string[]>();
  for (const match of server.matchAll(/app\.use\(\s*'([^']+)',\s*(create\w+)\(/g)) {
    const [, path, factory] = match as unknown as [string, string, string];
    mounts.set(factory, [...(mounts.get(factory) ?? []), path]);
  }
  return mounts;
}

const EXPECTED: ReadonlyArray<readonly [factory: string, path: string]> = [
  // Matches divo_desktop_json_request in src-tauri/src/core/divo/commands.rs.
  ['createDesktopToolsRoutes', '/api/desktop/auth'],
  ['createDesktopDepartmentRoutes', '/api/desktop'],
  ['createDesktopApprovalRoutes', '/api/desktop'],
  ['createDesktopAuthRoutes', '/api/desktop/auth'],
];

describe('desktop route mounts', () => {
  it('mounts every desktop router exactly once, at the prefix the app calls', () => {
    const mounts = mountedPaths();
    for (const [factory, path] of EXPECTED) {
      assert.deepEqual(mounts.get(factory), [path], `${factory} must be mounted only at ${path}`);
    }
  });

  it('keeps department and approval routers off the tools prefix', () => {
    // These two are called with the plain /api/desktop base. Mounting either
    // under /auth would make every one of their endpoints unreachable.
    const mounts = mountedPaths();
    for (const factory of ['createDesktopDepartmentRoutes', 'createDesktopApprovalRoutes']) {
      assert.ok(
        !(mounts.get(factory) ?? []).some(path => path.startsWith('/api/desktop/auth')),
        `${factory} must not be mounted under the auth prefix`,
      );
    }
  });
});
