/**
 * Reproduce production-style flow WITH conversation history (prior turns) and
 * see if a long history triggers the thought_signature parse bug.
 *
 * Run: pnpm tsx scripts/probe-with-history.ts
 */
import 'dotenv/config';
import { generateText, stepCountIs, dynamicTool } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';

const apiKey   = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_GENERATIVE_AI_API_KEY']!;
const MODEL_ID = (process.env['MODEL_ID'] ?? 'gemini-3.1-flash-lite-preview') as any;
const google   = createGoogleGenerativeAI({ apiKey });

const tools = {
  larkTask: dynamicTool({
    description: 'Create a Lark task',
    inputSchema: z.object({ title: z.string(), assignee: z.string() }) as never,
    execute: async (a: unknown): Promise<string> => {
      const args = a as { title: string; assignee: string };
      return JSON.stringify({ taskId: 't-1', status: 'created', title: args.title, assignee: args.assignee });
    },
  }),
};

async function main() {
  const messages = [
    { role: 'user' as const,      content: 'What can you do?' },
    { role: 'assistant' as const, content: 'I can create Lark tasks, send messages, and more.' },
    { role: 'user' as const,      content: 'Can you list my tasks?' },
    { role: 'assistant' as const, content: 'Sure! You currently have 3 active tasks.' },
    { role: 'user' as const,      content: 'Create a task titled "Visa Monitoring" assigned to Anish.' },
  ];

  console.log(`\n=== With ${messages.length} prior history turns ===`);
  try {
    const r = await generateText({
      model:   google(MODEL_ID),
      system:  'You are a Lark workspace assistant. Use larkTask to create tasks.',
      messages,
      tools,
      stopWhen: [stepCountIs(5)],
    });
    console.log(`OK steps=${r.steps.length} text=${r.text.slice(0,100)}`);
    r.steps.forEach((s, i) => {
      const reqBody = (s.request as any)?.body;
      let bodyObj: any = null;
      if (reqBody) try { bodyObj = typeof reqBody === 'string' ? JSON.parse(reqBody) : reqBody; } catch {}
      const contents = bodyObj?.contents ?? [];
      console.log(`  step ${i}: ${contents.length} contents`);
      contents.forEach((c: any, idx: number) => {
        const role = c.role;
        c.parts?.forEach((p: any, k: number) => {
          const what = p.functionCall ? `fn(${p.functionCall.name})` : p.functionResponse ? `fnResp(${p.functionResponse.name})` : p.text != null ? `text(${String(p.text).slice(0,30)}, thought=${p.thought ?? false})` : Object.keys(p).join(',');
          const sig  = p.thoughtSignature ? `sig(${String(p.thoughtSignature).slice(0,8)}…,len=${String(p.thoughtSignature).length})` : 'no-sig';
          console.log(`    contents[${idx}] ${role} part[${k}]: ${what}  ${sig}`);
        });
      });
    });
  } catch (e: any) {
    console.log('FAILED:', String(e?.message ?? e).slice(0, 600));
  }
}

main();
