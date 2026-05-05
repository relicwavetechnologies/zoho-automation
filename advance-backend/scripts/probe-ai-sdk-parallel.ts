/**
 * Reproduce the exact production failure: streamText with dynamicTool, parallel
 * tool calls, multi-step. This is what the supervisor does.
 *
 * Run: pnpm tsx scripts/probe-ai-sdk-parallel.ts
 */
import 'dotenv/config';
import { streamText, generateText, stepCountIs, dynamicTool, wrapLanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';

const API_KEY  = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
const MODEL_ID = (process.env['MODEL_ID'] ?? 'gemini-3.1-flash-lite-preview') as any;
if (!API_KEY) { console.error('Missing API key'); process.exit(1); }

const google = createGoogleGenerativeAI({ apiKey: API_KEY });
const taskSchema = z.object({ task: z.string() });

function buildDispatcher() {
  return {
    larkAgent: dynamicTool({
      description: 'Execute Lark workspace operations: tasks, calendar, etc.',
      inputSchema: taskSchema as never,
      execute: async (input: unknown): Promise<string> => {
        const { task } = input as { task: string };
        // Inside this dispatcher, simulate a sub-runner that creates a task and replies
        const subModel = google(MODEL_ID);
        const subTools = {
          create_task: dynamicTool({
            description: 'Create a Lark task',
            inputSchema: z.object({ title: z.string(), assignee: z.string().optional() }) as never,
            execute: async (a: unknown): Promise<string> => {
              const args = a as { title: string; assignee?: string };
              return JSON.stringify({ taskId: `task-${Math.random().toString(36).slice(2,7)}`, status: 'created', title: args.title });
            },
          }),
        };
        const r = await generateText({
          model:    subModel,
          prompt:   task,
          tools:    subTools,
          stopWhen: [stepCountIs(5)],
        });
        return r.text || 'done';
      },
    }),
  } as any;
}

async function probeStream(label: string, model: any, providerOptions?: any) {
  console.log(`\n=== ${label} ===`);
  try {
    const r = streamText({
      model,
      system:  'You are a supervisor. Use the larkAgent tool to delegate.',
      prompt:  'Create three Lark tasks in parallel: "Visa Monitoring" assigned to Anish, "GitHub Actions Demo" assigned to Anish, "Divo" assigned to Anish. Use larkAgent for each.',
      tools:   buildDispatcher(),
      stopWhen: [stepCountIs(8)],
      ...(providerOptions ? { providerOptions } : {}),
    });

    let toolCalls = 0;
    let textOut   = '';
    for await (const chunk of r.fullStream) {
      if (chunk.type === 'tool-call')   toolCalls++;
      if (chunk.type === 'text-delta')  textOut += chunk.text;
      if (chunk.type === 'error')       console.log('  ERROR chunk:', String(chunk.error).slice(0, 250));
    }
    const steps = await r.steps;
    console.log(`OK steps=${steps.length} toolCalls=${toolCalls} text=${textOut.slice(0,100)}`);

    steps.forEach((s, i) => {
      const reqBody = (s.request as any)?.body;
      let bodyObj: any = null;
      if (reqBody) try { bodyObj = typeof reqBody === 'string' ? JSON.parse(reqBody) : reqBody; } catch {}
      const modelTurns = (bodyObj?.contents ?? []).filter((c: any) => c.role === 'model');
      modelTurns.forEach((c: any, j: number) => {
        c.parts?.forEach((p: any, k: number) => {
          const what = p.functionCall ? `fn(${p.functionCall.name})` : p.text != null ? `text(${String(p.text).slice(0,30)})` : Object.keys(p).join(',');
          const sig  = p.thoughtSignature ? `sig(${String(p.thoughtSignature).slice(0,8)}…)` : 'no-sig';
          console.log(`  step ${i}, modelTurn ${j}, part ${k}: ${what} ${sig}`);
        });
      });
    });
  } catch (e: any) {
    console.log('FAILED:', String(e?.message ?? e).slice(0, 400));
  }
}

async function main() {
  // Plain google model
  await probeStream('streamText + parallel dynamicTool calls (vanilla model)', google(MODEL_ID));

  // With withFallback wrapper (production setup)
  const wrapped = wrapLanguageModel({
    model: google(MODEL_ID),
    middleware: {
      specificationVersion: 'v3',
      wrapGenerate: async ({ doGenerate }) => doGenerate(),
      wrapStream:   async ({ doStream })   => doStream(),
    },
  });
  await probeStream('streamText + parallel dynamicTool calls (wrapped via wrapLanguageModel)', wrapped);
}

main().catch(e => { console.error(e); process.exit(1); });
