import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWorkNativeContracts } from '../../src/application/gateway/work-contract-bootstrap-concurrency';

const requested = ['one', 'two', 'three', 'four'].map(nativeTool => ({ nativeTool }));

test('native contract loading is bounded at two and preserves request order', async () => {
  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];
  const load = async (item: { readonly nativeTool: string }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>(resolve => releases.push(resolve));
    active -= 1;
    return { toolId: item.nativeTool, nativeTool: item.nativeTool, inputSchema: {} };
  };
  const loading = loadWorkNativeContracts(requested, load);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maxActive, 2);
  releases.splice(0).forEach(release => release());
  await new Promise(resolve => setImmediate(resolve));
  releases.splice(0).forEach(release => release());

  const result = await loading;
  assert.equal(maxActive, 2);
  assert.deepEqual(result.contracts.map(contract => contract.nativeTool), [
    'one', 'two', 'three', 'four',
  ]);
});

test('one failed native contract stays isolated and cancellation stops the load', async () => {
  const partial = await loadWorkNativeContracts(requested.slice(0, 3), async item => {
    if (item.nativeTool === 'two') throw new Error('schema unavailable');
    return { toolId: item.nativeTool, nativeTool: item.nativeTool, inputSchema: {} };
  });
  assert.deepEqual(partial.contracts.map(contract => contract.nativeTool), ['one', 'three']);
  assert.deepEqual(partial.unavailableNativeTools, ['two']);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadWorkNativeContracts(requested, async item => ({
      toolId: item.nativeTool,
      nativeTool: item.nativeTool,
      inputSchema: {},
    }), controller.signal),
    error => error instanceof DOMException && error.name === 'AbortError',
  );
});
