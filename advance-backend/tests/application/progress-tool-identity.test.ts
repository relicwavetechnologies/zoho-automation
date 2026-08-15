import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseProgressEvent } from '../../src/application/runtime/lark-pi-runtime.service.ts';
import { createRunTimelineReducer } from '../../src/application/channels/run-timeline.reducer.ts';

const gmailSearch = {
  type: 'tool_start',
  callId: 'c1',
  toolName: 'divo_google_gmail',
  detail: 'search_gmail_messages',
};

describe('what a governed call is on the way in', () => {
  it('recovers the capability from the tool the container ran', () => {
    assert.deepEqual(parseProgressEvent(gmailSearch), {
      type: 'tool_start',
      callId: 'c1',
      toolName: 'divo_google_gmail',
      toolId: 'googleGmail',
      detail: 'search_gmail_messages',
    });
  });

  /* A container that does send the id has the last word — it knows what it
     dispatched, and the name is only a fallback for the typed tools that carry
     their id nowhere else. */
  it('prefers an id the container stated over one read from the name', () => {
    const event = parseProgressEvent({ ...gmailSearch, toolId: 'googleDrive' });
    assert.equal(event?.type === 'tool_start' && event.toolId, 'googleDrive');
  });

  /* Pi's own tools share the prefix. Naming one after a vendor would draw that
     vendor's mark beside work it had nothing to do with. */
  it('leaves a tool this backend does not govern unnamed', () => {
    const event = parseProgressEvent({ type: 'tool_start', callId: 'c2', toolName: 'divo_todos' });
    assert.equal(event?.type === 'tool_start' && event.toolId, undefined);
  });
});

/*
 * The whole chain, because each half was individually defensible and the pair
 * still produced `Google gmail · call`: the id was never recovered, so the row
 * fell back to spelling the container's own tool name out with spaces in it,
 * and the operation printed was the one that means "it called the tool".
 */
describe('what the reader ends up seeing', () => {
  it('names the product and the operation, and carries both identities', () => {
    const run = createRunTimelineReducer({ startedAtMs: 1_700_000_000_000 });
    run.apply(parseProgressEvent(gmailSearch)!);

    assert.deepEqual(run.timeline().ledger, [{
      id: 'c1',
      kind: 'tool',
      label: 'Gmail',
      count: 1,
      status: 'running',
      outcome: 'Search gmail messages',
      toolName: 'divo_google_gmail',
      toolId: 'googleGmail',
    }]);
  });

  /* The reducer erases the log it has built when a protected read starts, and
     it decides that from the tool id. With no id arriving, the test that proves
     the erasure passed on a hand-written event while the real one could not
     have triggered it — latent rather than live, because the protected Shopify
     tools sit behind SHOPIFY_PROTECTED_DATA_TOOLS_ENABLED, but it would have
     been live the day that flag was turned on. */
  it('still erases the log when a protected read arrives as a typed tool', () => {
    const run = createRunTimelineReducer({ startedAtMs: 1_700_000_000_000 });
    run.apply({ type: 'say', index: 0, text: 'Looking up the customer.' });
    run.apply(parseProgressEvent({
      type: 'tool_start',
      callId: 'c9',
      toolName: 'divo_shopify_customers',
      detail: 'alice@example.test',
    })!);

    assert.equal(run.timeline().ledger, undefined);
    assert.equal(run.protectedDataUsed, true);
  });

  // The operation that only says a tool was called earns no words of its own.
  it('says nothing extra when the operation is the plumbing', () => {
    const run = createRunTimelineReducer({ startedAtMs: 1_700_000_000_000 });
    run.apply(parseProgressEvent({ ...gmailSearch, detail: 'call' })!);

    const row = run.timeline().ledger?.[0];
    assert.equal(row?.label, 'Gmail');
    assert.equal(row?.outcome, undefined);
  });
});
