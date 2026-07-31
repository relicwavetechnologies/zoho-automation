import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvaDesignTool } from '../../src/application/tools/families/canva-design.tool.ts';
import { makeAllowedPerm, makeCtx, makeDeniedPerm } from './tool-test.helpers.ts';

describe('canvaDesign tool', () => {
  it('classifies the allowed Canva MCP operations before execution', () => {
    const tool = createCanvaDesignTool({ getClient: async () => null });
    assert.equal(
      (tool.permissionCheck({ connectionId: 'canva-1', op: 'search_designs' }, makeAllowedPerm('canvaDesign', ['read'])) as any).value,
      'read',
    );
    assert.equal(
      (tool.permissionCheck({ connectionId: 'canva-1', op: 'generate_design' }, makeAllowedPerm('canvaDesign', ['create'])) as any).value,
      'create',
    );
    assert.equal(
      (tool.permissionCheck({ connectionId: 'canva-1', op: 'perform_editing_operations' }, makeAllowedPerm('canvaDesign', ['update'])) as any).value,
      'update',
    );
    assert.equal(tool.permissionCheck({ connectionId: 'canva-1', op: 'export_design' }, makeDeniedPerm()).ok, false);
  });

  it('passes only an allow-listed Canva MCP tool name and requires read access for searches', async () => {
    const calls: unknown[] = [];
    const nativeCalls: unknown[] = [];
    const tool = createCanvaDesignTool({
      getClient: async (input) => {
        calls.push(input);
        return { callTool: async (name, args) => {
          nativeCalls.push({ name, args });
          return { designs: [] };
        } };
      },
    });

    const result = await tool.execute({
      connectionId: 'canva-1',
      op: 'search_designs',
      input: { query: 'Q3 launch' },
    }, makeCtx('canvaDesign', ['read']));

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{
      companyId: 'co-test',
      userId: 'user-test',
      connectionId: 'canva-1',
      minimumAccess: 'read_only',
    }]);
    assert.deepEqual(nativeCalls, [{ name: 'search-designs', args: { query: 'Q3 launch' } }]);
  });

  it('requires write access for design mutations and does not expose an arbitrary MCP tool name', async () => {
    const calls: unknown[] = [];
    const tool = createCanvaDesignTool({
      getClient: async (input) => {
        calls.push(input);
        return { callTool: async () => ({ design_id: 'd1' }) };
      },
    });

    const result = await tool.execute({
      connectionId: 'canva-1',
      op: 'generate_design',
      input: { prompt: 'Launch post' },
    }, makeCtx('canvaDesign', ['create']));

    assert.equal(result.ok, true);
    assert.equal((calls[0] as any).minimumAccess, 'read_write');
    assert.equal(tool.argsSchema.safeParse({ connectionId: 'canva-1', op: 'arbitrary_server_tool' }).success, false);
  });

  it('returns a controlled error when the shared connection is inaccessible', async () => {
    const tool = createCanvaDesignTool({ getClient: async () => null });
    const result = await tool.execute({ connectionId: 'canva-1', op: 'get_design' }, makeCtx('canvaDesign', ['read']));
    assert.equal(result.ok, false);
    assert.equal((result as any).error.payload.reason, 'unrecoverable');
  });
});
