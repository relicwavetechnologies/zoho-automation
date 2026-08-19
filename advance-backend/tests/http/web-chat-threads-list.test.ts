/**
 * How much of their history a reader is allowed to see.
 *
 * The rail used to draw eight chats and stop, with nothing saying the rest
 * existed. These are the two facts that keep that from happening quietly again:
 * the window the reader asked for is the window that reaches the store, and
 * "there is more behind this" is carried out rather than inferred from a full
 * page.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createWebChatRoutes } from '../../src/http/desktop/web-chat.routes';
import { WEB_THREAD_LIST_PAGE } from '../../src/domain/channel/web-thread';
import { ok } from '../../src/shared/result';
import type { Logger } from '../../src/shared/logger';

const noopLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLogger,
};

const servers: Server[] = [];
after(() => { for (const server of servers) server.close(); });

/** Stands the router up with a store that records what it was asked for. */
async function harness(page: { threads: unknown[]; hasMore: boolean }) {
  const asked: (number | undefined)[] = [];
  const app = express();
  app.use((_req, res, next) => {
    res.locals['companyId'] = 'company-1';
    res.locals['userId'] = 'user-1';
    res.locals['aiRole'] = 'MEMBER';
    res.locals['sessionId'] = 'session-1';
    next();
  });
  app.use('/api/web-chat', createWebChatRoutes({
    webRuns: {} as never,
    registry: { activeFor: () => [] } as never,
    threads: {
      list: async (_query: unknown, limit?: number) => { asked.push(limit); return ok(page); },
    } as never,
    logger: noopLogger,
    maxUploadBytes: 1_024,
  } as never));

  const server = createServer(app);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    asked,
    get: async (query: string) =>
      await (await fetch(`http://127.0.0.1:${port}/api/web-chat/threads${query}`)).json(),
  };
}

describe('GET /threads', () => {
  it('asks the store for the window the reader is looking at', async () => {
    const { asked, get } = await harness({ threads: [], hasMore: false });
    await get('?limit=75');
    assert.equal(asked[0], 75);
  });

  it('falls back to one page when the limit is junk, rather than refusing', async () => {
    const { asked, get } = await harness({ threads: [], hasMore: false });
    await get('?limit=not-a-number');
    await get('?limit=-4');
    await get('');
    assert.deepEqual(asked, [
      WEB_THREAD_LIST_PAGE, WEB_THREAD_LIST_PAGE, WEB_THREAD_LIST_PAGE,
    ]);
  });

  it('carries out whether anything is behind the window', async () => {
    const { get } = await harness({ threads: [], hasMore: true });
    const body = await get('?limit=25') as { hasMore: boolean };
    /* Without this the rail has to guess from a full page, and guesses wrong
       exactly when the count is a multiple of the page size — offering a
       "Show more" that loads nothing. */
    assert.equal(body.hasMore, true);
  });
});
