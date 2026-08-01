import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMemoryRoutes } from '../../src/http/admin/memory.routes.ts';

describe('canonical memory admin routes', () => {
  let server: Server;
  let baseUrl = '';
  let databaseReads = 0;

  before(async () => {
    const app = express();
    app.use((req, res, next) => {
      res.locals['companyId'] = 'company-1';
      res.locals['adminRole'] = req.headers['x-test-role'];
      res.locals['isSuperAdmin'] = req.headers['x-test-role'] === 'SUPER_ADMIN';
      next();
    });
    app.use('/api/admin/memories', createMemoryRoutes({
      prisma: {
        knowledgeResource: {
          findMany: async () => { databaseReads += 1; return []; },
        },
      } as never,
      operations: {
        health: async () => ({ status: 'ok' }),
        listFailedProjections: async () => [],
        retryFailedProjection: async () => false,
      } as never,
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('blocks a department-manager token before any company memory read', async () => {
    const beforeReads = databaseReads;
    const response = await fetch(`${baseUrl}/api/admin/memories/stats`, {
      headers: { 'x-test-role': 'DEPARTMENT_MANAGER' },
    });
    assert.equal(response.status, 403);
    assert.equal(databaseReads, beforeReads);
  });

  it('allows a live company administrator to read company-scoped statistics', async () => {
    const response = await fetch(`${baseUrl}/api/admin/memories/stats`, {
      headers: { 'x-test-role': 'COMPANY_ADMIN' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { data: unknown }).data, {
      totalPersonal: 0,
      totalDepartment: 0,
      totalCompany: 0,
    });
  });
});
