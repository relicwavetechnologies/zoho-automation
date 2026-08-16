import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attributeLatency, type LatencySpanSample } from '../../src/application/observability/latency-attribution';

function span(
  spanId: string,
  name: string,
  startedAtMs: number,
  endedAtMs: number,
  parentSpanId: string | null = null,
): LatencySpanSample {
  return {
    spanId,
    parentSpanId,
    name,
    category: name.startsWith('provider') ? 'provider' : 'gateway',
    source: 'test',
    startedAtMs,
    endedAtMs,
    status: 'ok',
  };
}

describe('attributeLatency', () => {
  it('subtracts nested child intervals instead of double-counting them', () => {
    const result = attributeLatency([
      span('root', 'gateway.request', 0, 1_000),
      span('provider', 'provider.continuation', 100, 900, 'root'),
      span('upstream', 'provider.upstream.headers', 100, 200, 'provider'),
    ]);

    assert.equal(result.observedWallMs, 1_000);
    assert.equal(result.instrumentedMs, 1_000);
    assert.equal(result.unattributedMs, 0);
    assert.deepEqual(
      Object.fromEntries(result.modules.map(module => [module.name, module.exclusiveMs])),
      {
        'provider.continuation': 700,
        'gateway.request': 200,
        'provider.upstream.headers': 100,
      },
    );
    assert.deepEqual(result.criticalPath.map(segment => [segment.name, segment.durationMs]), [
      ['gateway.request', 100],
      ['provider.upstream.headers', 100],
      ['provider.continuation', 700],
      ['gateway.request', 100],
    ]);
  });

  it('attributes overlapping work to the leaf that determines completion', () => {
    const result = attributeLatency([
      span('root', 'gateway.request', 0, 1_000),
      span('fast', 'gateway.fast', 0, 400, 'root'),
      span('slow', 'provider.slow', 0, 800, 'root'),
    ]);

    assert.deepEqual(result.criticalPath.map(segment => [segment.spanId, segment.durationMs]), [
      ['slow', 800],
      ['root', 200],
    ]);
    assert.deepEqual(result.modules.map(module => [module.name, module.criticalPathMs]), [
      ['provider.slow', 800],
      ['gateway.request', 200],
      ['gateway.fast', 0],
    ]);
  });

  it('reports gaps between unrelated spans as unattributed wall time', () => {
    const result = attributeLatency([
      span('one', 'gateway.one', 0, 100),
      span('two', 'gateway.two', 200, 300),
    ]);

    assert.equal(result.observedWallMs, 300);
    assert.equal(result.instrumentedMs, 200);
    assert.equal(result.unattributedMs, 100);
  });
});
