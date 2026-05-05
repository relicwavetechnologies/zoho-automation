/**
 * Diagnostic probe: log exactly what transformParams sees in the supervisor flow.
 * This reveals whether the assistant message arrives with or without a signature.
 *
 * Run: pnpm tsx scripts/probe-with-debug.ts
 */
import 'dotenv/config';
import { streamText, generateText, stepCountIs, dynamicTool, wrapLanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';

const apiKey   = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_GENERATIVE_AI_API_KEY']!;
const MODEL_ID = (process.env['MODEL_ID'] ?? 'gemini-3.1-flash-lite-preview') as any;
const google   = createGoogleGenerativeAI({ apiKey });

const taskSchema = z.object({ task: z.string() });

function logModel(label: string, model: any) {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v3',
      transformParams: async ({ params, type }) => {
        const prompt = (params as any).prompt as any[];
        console.log(`\n[${label}] transformParams type=${type} prompt has ${prompt?.length ?? 0} messages`);
        prompt?.forEach((m: any, i: number) => {
          if (m.role === 'assistant' && Array.isArray(m.content)) {
            const parts = (m.content as any[]).map((p: any) => {
              const sig = p.providerOptions?.google?.thoughtSignature;
              return `${p.type}${sig ? `(SIG ${String(sig).slice(0,8)})` : '(no-sig)'}`;
            }).join(', ');
            console.log(`  [${i}] assistant: [${parts}]`);
          } else if (m.role === 'tool' && Array.isArray(m.content)) {
            const parts = (m.content as any[]).map((p: any) => `${p.type}(${p.toolName})`).join(', ');
            console.log(`  [${i}] tool: [${parts}]`);
          } else {
            const c = typeof m.content === 'string' ? m.content.slice(0, 40) : '<parts>';
            console.log(`  [${i}] ${m.role}: ${c}`);
          }
        });
        return params;
      },
    },
  });
}

async function runLark(input: { task: string }, model: any): Promise<string> {
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
  const r = await generateText({
    model,
    prompt: input.task,
    tools,
    stopWhen: [stepCountIs(5)],
  });
  return r.text || 'done';
}

async function main() {
  const baseModel = logModel('SUPERVISOR', google(MODEL_ID));
  const subModel  = logModel('LARK_RUNNER', google(MODEL_ID));

  const dispatcher = {
    larkAgent: dynamicTool({
      description: 'Execute Lark workspace operations.',
      inputSchema: taskSchema as never,
      execute: async (i: unknown): Promise<string> => runLark(i as { task: string }, subModel),
    }),
  } as any;

  console.log('\n=== SUPERVISOR streamText probe ===');
  const r = streamText({
    model:    baseModel,
    system:   'You are a supervisor. Use larkAgent.',
    prompt:   'Create a task titled "Visa Monitoring" assigned to Anish.',
    tools:    dispatcher,
    stopWhen: [stepCountIs(5)],
  });

  let final = '';
  for await (const ch of r.fullStream) {
    if (ch.type === 'text-delta') final += ch.text;
    if (ch.type === 'error')      console.log('STREAM ERROR:', String(ch.error).slice(0, 250));
  }
  console.log(`\nFINAL TEXT: ${final.slice(0,150)}`);
}

main().catch(e => { console.error('crashed:', e); process.exit(1); });
