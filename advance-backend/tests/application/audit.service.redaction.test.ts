import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuditService } from '../../src/application/observability/audit.service.ts';
import { noopLogger } from '../tools/tool-test.helpers.ts';

describe('AuditService secret redaction', () => {
  it('recursively redacts browser and provider credentials', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const service = new AuditService({
      auditLog: { create: async (input: { data: Record<string, unknown> }) => { writes.push(input.data); } },
    } as never, noopLogger);
    service.record({
      actorId: 'user-1',
      companyId: 'co-1',
      action: 'semrush.query',
      outcome: 'success',
      metadata: { nested: { authorization: 'Apikey secret', Cookie: 'session=secret' }, apiKey: 'secret' },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(writes[0]?.metadata, {
      nested: { authorization: '[REDACTED]', Cookie: '[REDACTED]' },
      apiKey: '[REDACTED]',
    });
  });
});
