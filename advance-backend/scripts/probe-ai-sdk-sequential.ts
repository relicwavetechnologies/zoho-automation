/**
 * Reproduce sequential multi-step tool calls — the scenario where the lark
 * runner gets an ambiguous result, retries with a different name, then calls
 * again. Each model turn that emits a functionCall must carry its own
 * thought_signature back in history.
 *
 * Run: pnpm tsx scripts/probe-ai-sdk-sequential.ts
 */
import 'dotenv/config';
import { generateText, stepCountIs, dynamicTool } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';

const API_KEY  = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
const MODEL_ID = (process.env['MODEL_ID'] ?? 'gemini-3.1-flash-lite-preview') as any;
if (!API_KEY) { console.error('Missing API key'); process.exit(1); }

const google = createGoogleGenerativeAI({ apiKey: API_KEY });

let attempt = 0;
const tools = {
  create_task: dynamicTool({
    description: 'Create a Lark task. Returns ambiguous if assignee is not unique.',
    inputSchema: z.object({ title: z.string(), assignee: z.string() }) as never,
    execute: async (input: unknown): Promise<string> => {
      attempt++;
      const args = input as { title: string; assignee: string };
      console.log(`  [tool call ${attempt}] title="${args.title}" assignee="${args.assignee}"`);
      // First call returns ambiguous. Model is expected to retry with another name.
      if (attempt === 1) {
        return JSON.stringify({
          status: 'ambiguous',
          message: 'Multiple matches for assignee "Anish": Kanishka Kumawat, Anish Suman, Manish Jangir. Please specify the full name.',
        });
      }
      if (attempt === 2) {
        return JSON.stringify({
          status: 'ambiguous',
          message: 'Multiple matches still. Please use the full name "Anish Suman".',
        });
      }
      return JSON.stringify({ taskId: 'task-123', status: 'created', title: args.title, assignee: args.assignee });
    },
  }),
};

async function main() {
  console.log(`\n=== Sequential multi-step tool calls (model: ${MODEL_ID}) ===`);
  try {
    const r = await generateText({
      model:   google(MODEL_ID),
      system:  'You are an assistant. Use create_task to create tasks. If a result is ambiguous, retry with a more specific name from the suggestions.',
      prompt:  'Create a task titled "Visa Monitoring" assigned to Anish.',
      tools,
      stopWhen: [stepCountIs(8)],
    });
    console.log(`OK steps=${r.steps.length} text=${r.text.slice(0,100)}`);
    r.steps.forEach((s, i) => {
      const reqBody = (s.request as any)?.body;
      let bodyObj: any = null;
      if (reqBody) try { bodyObj = typeof reqBody === 'string' ? JSON.parse(reqBody) : reqBody; } catch {}
      const modelTurns = (bodyObj?.contents ?? []).filter((c: any) => c.role === 'model');
      console.log(`  step ${i}: request has ${modelTurns.length} prior model turns`);
      modelTurns.forEach((c: any, j: number) => {
        c.parts?.forEach((p: any, k: number) => {
          const what = p.functionCall ? `fn(${p.functionCall.name})` : p.text != null ? `text(${String(p.text).slice(0,30)})` : Object.keys(p).join(',');
          const sig  = p.thoughtSignature ? `sig(${String(p.thoughtSignature).slice(0,8)}…,len=${String(p.thoughtSignature).length})` : 'NO-SIG';
          console.log(`    modelTurn ${j} part ${k}: ${what}  ${sig}`);
        });
      });
    });
  } catch (e: any) {
    console.log('FAILED:', String(e?.message ?? e).slice(0, 500));
  }
}

main();
