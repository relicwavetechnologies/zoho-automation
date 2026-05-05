/**
 * Reproduce the EXACT production flow:
 *   - supervisor uses streamText
 *   - dispatches to N parallel larkAgent runners (dynamicTool)
 *   - each runner uses generateText with its own dynamicTools
 *   - one runner gets an ambiguous result then retries (sequential 2-step)
 *
 * Goal: find the exact code path that loses thought_signatures in production.
 *
 * Run: pnpm tsx scripts/probe-supervisor-flow.ts
 */
import 'dotenv/config';
import { streamText, generateText, stepCountIs, dynamicTool } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { withFallback } from '../src/shared/model-fallback';

const MODEL_ID    = (process.env['MODEL_ID'] ?? 'gemini-3.1-flash-lite-preview') as any;
const apiKey      = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_GENERATIVE_AI_API_KEY']!;
const openaiKey   = process.env['OPENAI_API_KEY'] ?? '';

const google      = createGoogleGenerativeAI({ apiKey });
const openai      = createOpenAI({ apiKey: openaiKey });
const primary     = google(MODEL_ID);
const fallback    = openai('gpt-4o-mini');
const model       = withFallback(primary, fallback);

const taskSchema = z.object({ task: z.string() });

let runnerCallCount = 0;
async function runLarkAgent(input: { task: string }): Promise<string> {
  runnerCallCount++;
  const myCallId = runnerCallCount;
  console.log(`  >> larkAgent #${myCallId} start: "${input.task.slice(0, 50)}"`);

  let createAttempts = 0;
  const tools = {
    larkTask: dynamicTool({
      description: 'Create a Lark task. Returns ambiguous if assignee is not unique.',
      inputSchema: z.object({ title: z.string(), assignee: z.string() }) as never,
      execute: async (a: unknown): Promise<string> => {
        createAttempts++;
        const args = a as { title: string; assignee: string };
        // First attempt for "Anish" returns ambiguous, forcing a retry → multi-step
        if (createAttempts === 1 && /anish/i.test(args.assignee) && !/anish suman/i.test(args.assignee)) {
          return JSON.stringify({
            status: 'ambiguous',
            message: 'Multiple matches for "Anish": Kanishka Kumawat, Anish Suman, Manish Jangir. Use the full name to disambiguate.',
          });
        }
        return JSON.stringify({ taskId: `tk-${myCallId}-${createAttempts}`, status: 'created', title: args.title, assignee: args.assignee });
      },
    }),
  };

  try {
    const r = await generateText({
      model,
      system: 'You manage Lark. Use larkTask. If ambiguous, retry once with the suggested full name from the message.',
      prompt: input.task,
      tools,
      stopWhen: [stepCountIs(8)],
    });
    console.log(`  << larkAgent #${myCallId} ok (${createAttempts} task ops): ${r.text.slice(0, 60)}`);
    return r.text || 'done';
  } catch (e: any) {
    console.log(`  !! larkAgent #${myCallId} FAILED: ${String(e?.message ?? e).slice(0, 200)}`);
    return `error: ${String(e?.message ?? e).slice(0, 100)}`;
  }
}

const dispatcher = {
  larkAgent: dynamicTool({
    description: 'Execute Lark workspace operations.',
    inputSchema: taskSchema as never,
    execute: async (i: unknown) => runLarkAgent(i as { task: string }),
  }),
} as any;

async function main() {
  console.log(`\n=== Production-style supervisor flow (${MODEL_ID}, withFallback) ===`);
  try {
    const r = streamText({
      model,
      system:  'You are a supervisor. Use larkAgent for any Lark workspace task. You may call it in parallel.',
      prompt:  'Create three Lark tasks in parallel — all assigned to Anish: "Visa Monitoring", "GitHub Actions Demo", "Divo".',
      tools:   dispatcher,
      stopWhen: [stepCountIs(8)],
    });

    let toolCalls = 0;
    let textOut   = '';
    for await (const ch of r.fullStream) {
      if (ch.type === 'tool-call')  toolCalls++;
      if (ch.type === 'text-delta') textOut += ch.text;
      if (ch.type === 'error')      console.log('  STREAM ERROR:', String(ch.error).slice(0, 250));
    }
    const steps = await r.steps;
    console.log(`\nDONE steps=${steps.length} dispatchCalls=${toolCalls} text="${textOut.slice(0, 200)}"`);
  } catch (e: any) {
    console.log('STREAM TOTAL FAIL:', String(e?.message ?? e).slice(0, 600));
  }
}

main();
