import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { ToolRegistry } from '../../src/application/tools/tool-registry.ts';
import { asToolId } from '../../src/shared/ids.ts';
import { ok } from '../../src/shared/result.ts';

describe('ToolRegistry', () => {
  it('fails fast instead of silently replacing a duplicate tool authority', () => {
    const registry = new ToolRegistry();
    const tool = {
      id: asToolId('shopifyAnalytics'),
      family: 'shopify' as const,
      actionGroups: new Set(['read' as const]),
      argsSchema: z.object({}),
      resultSchema: z.object({ status: z.string() }),
      description: 'test',
      parameterDocs: 'none',
      permissionCheck: () => ok('read' as const),
      execute: async () => ok({ status: 'complete' }),
    };

    registry.register(tool);
    assert.throws(() => registry.register(tool), /already registered/);
    assert.equal(registry.all().length, 1);
  });
});
