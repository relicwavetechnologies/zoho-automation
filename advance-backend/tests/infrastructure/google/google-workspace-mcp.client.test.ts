import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { GoogleWorkspaceMcpClient } from '../../../src/infrastructure/google/google-workspace-mcp.client.ts';

describe('GoogleWorkspaceMcpClient cancellation', () => {
  it('closes an in-flight MCP HTTP request when the parent run aborts', async () => {
    let requestSeen!: () => void;
    const seen = new Promise<void>(resolve => { requestSeen = resolve; });
    let responseClosed!: () => void;
    const closed = new Promise<void>(resolve => { responseClosed = resolve; });
    const server = createServer((_request, response) => {
      requestSeen();
      response.on('close', responseClosed);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address() as AddressInfo;
    const controller = new AbortController();
    const client = new GoogleWorkspaceMcpClient(
      'test-token',
      `http://127.0.0.1:${address.port}/mcp`,
      {
        describe: async (_name: string, load: () => Promise<unknown>) => {
          await load();
          return null;
        },
      } as any,
    );

    try {
      const pending = client.describeTool('blocked_operation', controller.signal);
      await seen;
      controller.abort(new Error('parent run cancelled'));

      await assert.rejects(pending, /abort|cancel|closed/i);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('MCP HTTP request remained open')), 500);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
