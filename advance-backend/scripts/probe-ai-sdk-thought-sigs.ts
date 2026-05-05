/**
 * Probe how @ai-sdk/google + ai's generateText handles thought_signatures
 * across a multi-step tool call. Logs the raw request/response of step 2 to
 * see whether the signature from step 1 is properly preserved in history.
 *
 * Run: pnpm tsx scripts/probe-ai-sdk-thought-sigs.ts
 */
import 'dotenv/config';
import { generateText, stepCountIs, tool } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';

const API_KEY  = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
const MODEL_ID = (process.env['MODEL_ID'] ?? 'gemini-3.1-flash-lite-preview') as any;
if (!API_KEY) { console.error('Missing API key'); process.exit(1); }

const google = createGoogleGenerativeAI({ apiKey: API_KEY });

async function probe(label: string, providerOptions?: any): Promise<void> {
  console.log(`\n=== ${label} ===`);
  const model = google(MODEL_ID);

  const tools = {
    create_task: tool({
      description: 'Create a task',
      inputSchema: z.object({ title: z.string(), assignee: z.string().optional() }),
      execute: async (args) => ({ taskId: 'task-123', status: 'created', title: args.title }),
    }),
  };

  try {
    const r = await generateText({
      model,
      prompt:   'Create a task titled "Visa Monitoring" assigned to Anish.',
      tools,
      stopWhen: [stepCountIs(5)],
      ...(providerOptions ? { providerOptions } : {}),
    });
    console.log(`OK steps=${r.steps.length} text=${r.text.slice(0,80)}`);
    r.steps.forEach((s, i) => {
      const callsCount = s.toolCalls?.length ?? 0;
      const reqBody    = (s.request as any)?.body;
      // Decode request body to see history sent in step (i+1)
      let bodyObj: any = null;
      if (reqBody) {
        try { bodyObj = typeof reqBody === 'string' ? JSON.parse(reqBody) : reqBody; } catch {}
      }
      const sigsOnRequestModelTurn = bodyObj?.contents?.flatMap((c: any) =>
        c.role === 'model' ? (c.parts ?? []).map((p: any) => p.thoughtSignature ? `sig(${String(p.thoughtSignature).slice(0,8)}…)` : 'no-sig') : []
      ) ?? [];
      console.log(`  step ${i}: toolCalls=${callsCount}  history-model-sigs=[${sigsOnRequestModelTurn.join(', ')}]`);
    });
  } catch (e: any) {
    console.log('FAILED:', String(e.message ?? e).slice(0, 300));
  }
}

async function main() {
  await probe('Default (no providerOptions)');
  await probe('thinkingBudget: 0', { google: { thinkingConfig: { thinkingBudget: 0 } } });
  await probe('thinkingBudget: -1 (dynamic)', { google: { thinkingConfig: { thinkingBudget: -1 } } });
}

main();
