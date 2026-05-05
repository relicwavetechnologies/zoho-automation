/**
 * Integration test: verify withGeminiSignatures correctly preserves and salvages
 * thoughtSignatures across multi-step tool calls, including pathological cases
 * where the @ai-sdk/google parser misattributes the signature.
 *
 * Run: pnpm tsx scripts/test-gemini-signature-fix.ts
 */
import 'dotenv/config';
import { generateText, streamText, stepCountIs, dynamicTool, wrapLanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { withGeminiSignatures, correctPromptSignatures } from '../src/shared/gemini-thought-signatures';

const apiKey   = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_GENERATIVE_AI_API_KEY']!;
const MODEL_ID = (process.env['MODEL_ID'] ?? 'gemini-3.1-flash-lite-preview') as any;
const google   = createGoogleGenerativeAI({ apiKey });

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}`); }
}

// ─── Unit tests for correctPromptSignatures ─────────────────────────────────
console.log('\n=== Unit: correctPromptSignatures ===');

// Case 1: tool-call already has signature → no change
{
  const prompt = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 't1', toolName: 'x', input: {}, providerOptions: { google: { thoughtSignature: 'SIG_A' } } },
    ]},
  ] as const;
  const out = correctPromptSignatures(prompt as any);
  assert(out === prompt, 'untouched when first tool-call already has sig');
}

// Case 2: text part has sig, first tool-call has none → moved to first tool-call
{
  const prompt = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [
      { type: 'text', text: 'thinking', providerOptions: { google: { thoughtSignature: 'SIG_B' } } },
      { type: 'tool-call', toolCallId: 't1', toolName: 'x', input: {} },
    ]},
  ] as any;
  const out = correctPromptSignatures(prompt) as any;
  const fixedTool = out[1].content[1];
  assert(fixedTool.providerOptions?.google?.thoughtSignature === 'SIG_B', 'sig salvaged from preceding text part');
}

// Case 3 (cloudwego): tool-call WITHOUT sig, FOLLOWING text WITH sig → moved
{
  const prompt = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 't1', toolName: 'x', input: {} },
      { type: 'text', text: 'after', providerOptions: { google: { thoughtSignature: 'SIG_C' } } },
    ]},
  ] as any;
  const out = correctPromptSignatures(prompt) as any;
  const fixedTool = out[1].content[0];
  assert(fixedTool.providerOptions?.google?.thoughtSignature === 'SIG_C', 'sig salvaged from following text part (cloudwego case)');
}

// Case 4: parallel tool calls — first has sig, others don't → must NOT add sig to others
{
  const prompt = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 't1', toolName: 'x', input: {}, providerOptions: { google: { thoughtSignature: 'SIG_D' } } },
      { type: 'tool-call', toolCallId: 't2', toolName: 'x', input: {} },
      { type: 'tool-call', toolCallId: 't3', toolName: 'x', input: {} },
    ]},
  ] as any;
  const out = correctPromptSignatures(prompt) as any;
  assert(out[1].content[0].providerOptions?.google?.thoughtSignature === 'SIG_D', 'first parallel call keeps its sig');
  assert(!out[1].content[1].providerOptions?.google?.thoughtSignature, 'second parallel call has NO sig');
  assert(!out[1].content[2].providerOptions?.google?.thoughtSignature, 'third parallel call has NO sig');
}

// Case 5: text-only assistant turn → never modified
{
  const prompt = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [
      { type: 'text', text: 'reply', providerOptions: { google: { thoughtSignature: 'SIG_E' } } },
    ]},
  ] as any;
  const out = correctPromptSignatures(prompt) as any;
  assert(out[1].content[0].providerOptions?.google?.thoughtSignature === 'SIG_E', 'text-only turn untouched');
}

// Case 6: no signatures anywhere → no-op
{
  const prompt = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'x', input: {} }] },
  ] as any;
  const out = correctPromptSignatures(prompt);
  assert(out === prompt, 'no-op when no signatures present');
}

// Case 7: multi-turn — each turn corrected independently
{
  const prompt = [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 't1', providerOptions: { google: { thoughtSignature: 'TURN1' } } },
      { type: 'tool-call', toolCallId: 't1', toolName: 'x', input: {} },
    ]},
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'x', output: { type: 'json', value: {} } }] },
    { role: 'user', content: 'two' },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 't2', providerOptions: { google: { thoughtSignature: 'TURN2' } } },
      { type: 'tool-call', toolCallId: 't2', toolName: 'x', input: {} },
    ]},
  ] as any;
  const out = correctPromptSignatures(prompt) as any;
  assert(out[1].content[1].providerOptions?.google?.thoughtSignature === 'TURN1', 'turn 1 sig moved');
  assert(out[4].content[1].providerOptions?.google?.thoughtSignature === 'TURN2', 'turn 2 sig moved');
}

async function liveTests() {
// ─── Live integration tests against real Gemini ─────────────────────────────
console.log('\n=== Live: withGeminiSignatures end-to-end ===');

const wrapped = withGeminiSignatures(google(MODEL_ID));

const tools = {
  larkTask: dynamicTool({
    description: 'Create a Lark task',
    inputSchema: z.object({ title: z.string(), assignee: z.string() }) as never,
    execute: async (a: unknown): Promise<string> => {
      const args = a as { title: string; assignee: string };
      return JSON.stringify({ taskId: 'tk-1', status: 'created', title: args.title, assignee: args.assignee });
    },
  }),
};

// Live 1: simple multi-step generateText
{
  console.log('\n  -- live: generateText sequential single tool call');
  const r = await generateText({
    model:    wrapped,
    prompt:   'Create a task titled "Visa Monitoring" assigned to Anish.',
    tools,
    stopWhen: [stepCountIs(5)],
  });
  assert(r.steps.length >= 2, 'generateText completed multi-step');
  assert(r.text.length > 0, 'generateText produced final text');
}

// Live 2: streamText with parallel tool calls
{
  console.log('\n  -- live: streamText parallel tool calls');
  const r = streamText({
    model:    wrapped,
    prompt:   'Create three tasks in parallel — assigned to Anish: "A", "B", "C".',
    tools,
    stopWhen: [stepCountIs(5)],
  });
  let toolCalls = 0;
  let final = '';
  let streamErr = '';
  for await (const ch of r.fullStream) {
    if (ch.type === 'tool-call') toolCalls++;
    if (ch.type === 'text-delta') final += ch.text;
    if (ch.type === 'error')      streamErr = String(ch.error);
  }
  assert(streamErr === '', `streamText completed without error (got: ${streamErr.slice(0, 120)})`);
  assert(toolCalls >= 1, `streamText made >=1 tool calls (made ${toolCalls})`);
  assert(final.length > 0, 'streamText produced final text');
}

// Live 3: synthetic broken history — simulate SDK losing signature on tool-call
// We pre-build a history where the previous assistant turn has its sig on the
// reasoning part (not on tool-call) and confirm Gemini accepts it after correction.
{
  console.log('\n  -- live: pre-built history with sig misattributed to reasoning part');
  // Step 1 — get a real signature from Gemini
  const seed = await generateText({
    model:    google(MODEL_ID),
    prompt:   'Create a task titled "Seed" assigned to Anish.',
    tools,
    stopWhen: [stepCountIs(2)],
  });
  // Pull the actual signature out of the seed's first step assistant content.
  const seedSig = (seed.steps[0]?.content ?? []).find((p: any) => p.type === 'tool-call')?.providerMetadata?.google?.thoughtSignature;
  assert(typeof seedSig === 'string' && seedSig.length > 0, 'seed produced a real signature');

  if (typeof seedSig !== 'string') {
    console.log('  (skipping — no signature available)');
  } else {
    // Build a malformed history: signature lives on a reasoning part, not on tool-call
    const broken = [
      { role: 'user', content: 'Create a task titled "Seed" assigned to Anish.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'I will create the task.', providerOptions: { google: { thoughtSignature: seedSig } } },
          { type: 'tool-call', toolCallId: 'tk-seed', toolName: 'larkTask', input: { title: 'Seed', assignee: 'Anish' } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tk-seed', toolName: 'larkTask', output: { type: 'json', value: { taskId: 'tk-seed', status: 'created' } } }] },
    ] as any;

    // First, prove the broken history actually breaks the raw model
    let rawFailed = false;
    try {
      await generateText({ model: google(MODEL_ID), messages: broken, tools, stopWhen: [stepCountIs(1)] });
    } catch (e: any) {
      rawFailed = /thought_signature/i.test(String(e?.message ?? e));
    }
    assert(rawFailed, 'raw google model rejects misattributed signature (expected 400)');

    // Now confirm wrapped model passes
    let wrappedOk = false;
    try {
      const r2 = await generateText({ model: wrapped, messages: broken, tools, stopWhen: [stepCountIs(2)] });
      wrappedOk = r2.text.length > 0 || r2.steps.length > 0;
    } catch (e: any) {
      console.log('  wrapped model failed:', String(e?.message ?? e).slice(0, 200));
    }
    assert(wrappedOk, 'wrapped model SALVAGES the misattributed signature and Gemini accepts');
  }
}
}

liveTests().then(() => {
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((e) => {
  console.error('Test runner crashed:', e);
  process.exit(2);
});
