import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderStreamMilestones } from '../../src/application/observability/provider-stream-milestones';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('ProviderStreamMilestones', () => {
  it('finds first DeepSeek reasoning and text across split SSE chunks', () => {
    let now = 10;
    const events: unknown[] = [];
    const detector = new ProviderStreamMilestones(event => events.push(event), () => now++);

    detector.observe(bytes('data: {"choices":[{"delta":{"reasoning_con'));
    detector.observe(bytes('tent":"checking"}}]}\n\ndata: {"choices":[{"delta":{"content":"done"}}]}\n\n'));
    detector.observe(bytes('data: {"choices":[{"delta":{"content":" again"}}]}\n\n'));
    detector.finish();

    assert.deepEqual(events, [
      { kind: 'first_byte', atMs: 10 },
      { kind: 'first_reasoning', atMs: 11 },
      { kind: 'first_text', atMs: 12 },
    ]);
  });

  it('adapts OpenAI Responses events without retaining output', () => {
    const events: unknown[] = [];
    const detector = new ProviderStreamMilestones(event => events.push(event), () => 20);
    detector.observe(bytes([
      'data: {"type":"response.reasoning_summary_text.delta","delta":"plan"}',
      'data: {"type":"response.output_text.delta","delta":"answer"}',
      '',
    ].join('\n')));
    detector.finish();

    assert.deepEqual(events.map((event: any) => event.kind), [
      'first_byte',
      'first_reasoning',
      'first_text',
    ]);
    assert.equal(JSON.stringify(detector).includes('answer'), false);
  });
});
