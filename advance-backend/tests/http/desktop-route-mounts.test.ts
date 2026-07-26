import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Where each desktop router is mounted.
 *
 * The router tests exercise routers in isolation, so none of them can see a
 * wrong prefix in server.ts. One did happen: the tools router was moved to
 * `/api/desktop/auth`, which took `/api/desktop/tools` off the air. The desktop
 * treats a 401 on an authoritative call as an expired session, so the symptom
 * was members being signed out moments after signing in.
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
  ['createDesktopToolsRoutes', '/api/desktop'],
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

  it('keeps member tool endpoints off the auth prefix', () => {
    // /api/desktop/auth is the OAuth and session surface. A member API mounted
    // under it is unreachable at the URL the desktop actually requests.
    const mounts = mountedPaths();
    for (const factory of ['createDesktopToolsRoutes', 'createDesktopDepartmentRoutes', 'createDesktopApprovalRoutes']) {
      assert.ok(
        !(mounts.get(factory) ?? []).some(path => path.startsWith('/api/desktop/auth')),
        `${factory} must not be mounted under the auth prefix`,
      );
    }
  });
});
