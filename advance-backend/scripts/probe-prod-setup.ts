/**
 * Use the EXACT production model wiring (withFallback wrapper) and run the
 * sequential-tool scenario to see whether the wrapper itself is what corrupts
 * the signature.
 *
 * Run: pnpm tsx scripts/probe-prod-setup.ts
 */
import 'dotenv/config';
import { generateText, stepCountIs, dynamicTool } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { withFallback } from '../src/shared/model-fallback';

const MODEL_ID = (process.env['MODEL_ID'] ?? 'gemini-3.1-flash-lite-preview') as any;
const apiKey   = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_GENERATIVE_AI_API_KEY']!;
const openaiKey = process.env['OPENAI_API_KEY'] ?? '';

const google = createGoogleGenerativeAI({ apiKey });
const openai = createOpenAI({ apiKey: openaiKey });
const primary  = google(MODEL_ID);
const fallback = openai('gpt-4o-mini');
const model    = withFallback(primary, fallback);

let attempt = 0;
const tools = {
  larkTask: dynamicTool({
    description: 'Create a Lark task. Returns ambiguous if assignee is unclear.',
    inputSchema: z.object({ title: z.string(), assignee: z.string() }) as never,
    execute: async (input: unknown): Promise<string> => {
      attempt++;
      const args = input as { title: string; assignee: string };
      console.log(`  [tool ${attempt}] title="${args.title}" assignee="${args.assignee}"`);
      if (attempt === 1) {
        return JSON.stringify({
          status:  'ambiguous',
          message: 'Multiple matches for "Anish": Kanishka Kumawat, Anish Suman, Manish Jangir.',
        });
      }
      return JSON.stringify({ taskId: 'task-123', status: 'created', title: args.title, assignee: args.assignee });
    },
  }),
};

async function main() {
  console.log(`\n=== Production setup probe (model: ${MODEL_ID}, withFallback) ===`);
  try {
    const r = await generateText({
      model,
      system:   'Use larkTask. If ambiguous, retry with a more specific name from the suggestions.',
      prompt:   'Create a task titled "Visa Monitoring" assigned to Anish.',
      tools,
      stopWhen: [stepCountIs(8)],
    });
    console.log(`OK steps=${r.steps.length} text=${r.text.slice(0,100)}`);
    r.steps.forEach((s, i) => {
      const reqBody = (s.request as any)?.body;
      let bodyObj: any = null;
      if (reqBody) try { bodyObj = typeof reqBody === 'string' ? JSON.parse(reqBody) : reqBody; } catch {}
      const modelTurns = (bodyObj?.contents ?? []).filter((c: any) => c.role === 'model');
      console.log(`  step ${i}: ${modelTurns.length} prior model turns`);
      modelTurns.forEach((c: any, j: number) => {
        c.parts?.forEach((p: any, k: number) => {
          const what = p.functionCall ? `fn(${p.functionCall.name})` : p.text != null ? `text(${String(p.text).slice(0,40)})` : Object.keys(p).join(',');
          const sig  = p.thoughtSignature ? `sig(${String(p.thoughtSignature).slice(0,8)}…,len=${String(p.thoughtSignature).length})` : 'NO-SIG';
          console.log(`    turn ${j} part ${k}: ${what}  ${sig}`);
        });
      });
    });
  } catch (e: any) {
    console.log('FAILED:', String(e?.message ?? e).slice(0, 600));
  }
}

main();
