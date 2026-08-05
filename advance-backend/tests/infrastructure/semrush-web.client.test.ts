import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextSemrushDpaRequestId,
  SemrushWebClient,
} from '../../src/infrastructure/semrush/semrush-web.client.ts';

describe('nextSemrushDpaRequestId', () => {
  it('matches the senior UUID-shaped DPA request_id format', () => {
    const id = nextSemrushDpaRequestId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.notEqual(id, nextSemrushDpaRequestId());
  });
});

describe('SemrushWebClient DPA RPC', () => {
  it('generates a fresh params.request_id on every call', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = new SemrushWebClient({
      apiKey: 'test-api-key',
      cookie: 'session=cookie',
      timeoutMs: 5_000,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: bodies.at(-1)?.id,
          result: [{
            database: 'in',
            domain: 'example.com',
            rank: 1,
            organicPositions: 10,
            organicTraffic: 100,
            organicTrafficCost: 50,
            adsPositions: 0,
            adsTraffic: 0,
            adsTrafficCost: 0,
            plaPositions: 0,
            plaCopies: 0,
          }],
        }), { status: 200 });
      },
    });

    await client.fetch({ operation: 'domain_overview', domain: 'example.com', database: 'in' });
    await client.fetch({ operation: 'domain_overview', domain: 'example.com', database: 'in' });

    assert.equal(bodies.length, 2);
    const first = (bodies[0]!.params as Record<string, unknown>).request_id;
    const second = (bodies[1]!.params as Record<string, unknown>).request_id;
    assert.match(String(first), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.match(String(second), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.notEqual(first, second);
  });
});
