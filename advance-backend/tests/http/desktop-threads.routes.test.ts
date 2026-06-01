import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Request, Response } from 'express';

import { createDesktopThreadsRoutes } from '../../src/http/desktop/desktop-threads.routes.ts';

const SECRET = 'test-member-secret-32-bytes-long';

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

function signJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + 600,
  })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

async function callRoute(
  router: ReturnType<typeof createDesktopThreadsRoutes>,
  method: 'GET' | 'POST',
  path: string,
  body: unknown = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let status = 200;
    let responseBody: unknown = undefined;
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve({ status, body: responseBody });
      }
    };

    const req = {
      method,
      path,
      url: path,
      params: {},
      query: {},
      body,
      headers: {
        authorization: `Bearer ${signJwt({
          sessionId: 'session-1',
          userId: 'user-1',
          companyId: 'company-1',
          role: 'MEMBER',
        })}`,
      },
    } as unknown as Request;

    const res = {
      locals: {},
      status: (s: number) => { status = s; return res; },
      json: (b: unknown) => { responseBody = b; finish(); return res; },
      send: (b: unknown) => { responseBody = b; finish(); return res; },
    } as unknown as Response;

    const stack = (router as any).stack as any[];
    const middleware = stack.find(item => !item.route);
    const routeLayer = stack.find(item => item.route?.path === path && item.route?.methods?.[method.toLowerCase()]);
    if (!middleware || !routeLayer) {
      resolve({ status: 404, body: { error: 'not_found' } });
      return;
    }

    Promise.resolve(
      middleware.handle(req, res, () => {
        const handler = routeLayer.route.stack[0]?.handle;
        return handler(req, res, () => {
          status = 404;
          responseBody = { error: 'next' };
          finish();
        });
      }),
    ).catch(error => resolve({ status: 500, body: String(error) }));
  });
}

describe('desktop threads routes', () => {
  it('upserts workspace identity when creating a desktop thread', async () => {
    let capturedWorkspaceUpsert: any;
    let capturedThreadCreate: any;
    const prisma = {
      memberSession: {
        findUnique: async () => ({
          sessionId: 'session-1',
          userId: 'user-1',
          companyId: 'company-1',
          role: 'MEMBER',
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      desktopWorkspace: {
        findFirst: async () => null,
        upsert: async (args: any) => {
          capturedWorkspaceUpsert = args;
          return {
            id: 'workspace-1',
            userId: 'user-1',
            companyId: 'company-1',
            path: '/tmp/repo',
            name: 'repo',
            lastOpenedAt: new Date('2026-05-28T12:00:00.000Z'),
            createdAt: new Date('2026-05-28T12:00:00.000Z'),
            updatedAt: new Date('2026-05-28T12:00:00.000Z'),
          };
        },
      },
      desktopThread: {
        create: async (args: any) => {
          capturedThreadCreate = args;
          return {
            id: 'thread-1',
            title: 'New conversation',
            workspaceId: args.data.workspaceId,
            workspacePath: args.data.workspacePath,
            workspaceName: args.data.workspaceName,
            lastMessageAt: null,
            workspace: {
              id: 'workspace-1',
              path: '/tmp/repo',
              name: 'repo',
              lastOpenedAt: new Date('2026-05-28T12:00:00.000Z'),
              createdAt: new Date('2026-05-28T12:00:00.000Z'),
              updatedAt: new Date('2026-05-28T12:00:00.000Z'),
            },
          };
        },
      },
    };

    const router = createDesktopThreadsRoutes({
      prisma: prisma as any,
      logger: noopLogger,
      memberJwtSecret: SECRET,
    });

    const result = await callRoute(router, 'POST', '/', {
      workspace: { path: '/tmp/repo/', name: 'repo' },
    });

    assert.equal(result.status, 201);
    assert.equal(capturedWorkspaceUpsert.where.companyId_userId_path.path, '/tmp/repo');
    assert.equal(capturedThreadCreate.data.workspaceId, 'workspace-1');
    assert.equal(capturedThreadCreate.data.workspacePath, '/tmp/repo');
    assert.equal(result.body.data.workspace.id, 'workspace-1');
    assert.equal(result.body.data.workspacePath, '/tmp/repo');
  });
});
