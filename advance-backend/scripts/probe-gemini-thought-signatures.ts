/**
 * Probe the Gemini API directly to observe the actual response structure
 * for thought signatures in function calling. This bypasses the AI SDK so we
 * can see exactly what Gemini returns and how the parts are laid out.
 *
 * Run: pnpm tsx scripts/probe-gemini-thought-signatures.ts
 */
import 'dotenv/config';

const API_KEY = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
const MODEL_ID = process.env['MODEL_ID'] ?? 'gemini-3.1-flash-lite-preview';

if (!API_KEY) {
  console.error('Missing GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY');
  process.exit(1);
}

const TOOL_DECL = {
  name: 'create_task',
  description: 'Create a task in the project tracker',
  parameters: {
    type: 'object',
    properties: {
      title:    { type: 'string', description: 'Task title' },
      assignee: { type: 'string', description: 'Person to assign' },
    },
    required: ['title'],
  },
};

async function callGemini(contents: unknown[]): Promise<{ raw: string; parsed: any }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent?key=${API_KEY}`;
  const body = {
    contents,
    tools: [{ functionDeclarations: [TOOL_DECL] }],
    generationConfig: { temperature: 0 },
  };
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const raw    = await res.text();
  const parsed = JSON.parse(raw);
  if (!res.ok) {
    console.error('HTTP', res.status, raw);
    throw new Error(`Gemini ${res.status}`);
  }
  return { raw, parsed };
}

function describeParts(parts: any[]): void {
  parts.forEach((p, i) => {
    const keys = Object.keys(p).join(', ');
    const sig  = p.thoughtSignature ? `sig=${String(p.thoughtSignature).slice(0, 12)}…(${String(p.thoughtSignature).length})` : 'sig=none';
    const kind = p.functionCall
      ? `functionCall(${p.functionCall.name})`
      : p.text != null
        ? `text("${String(p.text).slice(0, 40)}", thought=${p.thought ?? false}, len=${String(p.text).length})`
        : keys;
    console.log(`  [${i}] ${kind}  ${sig}`);
  });
}

async function main() {
  console.log(`\n=== Probing model: ${MODEL_ID} ===\n`);

  // ── Step 1: ask the model to create a task ──────────────────────────────
  console.log('STEP 1: send user task');
  const step1Contents = [
    { role: 'user', parts: [{ text: 'Create a task titled "Visa Monitoring" assigned to Anish.' }] },
  ];
  const step1 = await callGemini(step1Contents);
  const modelMessage1 = step1.parsed.candidates?.[0]?.content;
  console.log('STEP 1 model parts:');
  describeParts(modelMessage1?.parts ?? []);

  // ── Step 2: send a function response and see what step 2 looks like ─────
  console.log('\nSTEP 2: send functionResponse, verbatim history');
  const fnCall = modelMessage1.parts.find((p: any) => p.functionCall);
  if (!fnCall) {
    console.log('No function call returned. Skipping step 2.');
    return;
  }

  const step2Contents = [
    ...step1Contents,
    modelMessage1, // model turn — verbatim, including any thoughtSignatures
    { role: 'user', parts: [{ functionResponse: { name: fnCall.functionCall.name, response: { taskId: 'task-123', status: 'created' } } }] },
  ];

  try {
    const step2 = await callGemini(step2Contents);
    const modelMessage2 = step2.parsed.candidates?.[0]?.content;
    console.log('STEP 2 OK — model parts:');
    describeParts(modelMessage2?.parts ?? []);
  } catch (e) {
    console.log('STEP 2 FAILED:', String(e));
  }

  // ── Step 2': verify breakage when signatures stripped ───────────────────
  console.log("\nSTEP 2': same history but with all thoughtSignatures stripped");
  const stripped = JSON.parse(JSON.stringify(modelMessage1));
  stripped.parts.forEach((p: any) => { delete p.thoughtSignature; });

  const step2bContents = [
    ...step1Contents,
    stripped,
    { role: 'user', parts: [{ functionResponse: { name: fnCall.functionCall.name, response: { taskId: 'task-123', status: 'created' } } }] },
  ];

  try {
    const step2b = await callGemini(step2bContents);
    console.log("STEP 2' OK (unexpected — strip should have broken it)");
    describeParts(step2b.parsed.candidates?.[0]?.content?.parts ?? []);
  } catch (e) {
    console.log("STEP 2' FAILED (expected):", String(e).slice(0, 200));
  }

  // ── Step 2'': verify thinkingConfig: thinkingBudget: 0 actually disables sig ──
  console.log("\nSTEP 2'': thinkingBudget=0, fresh request, see whether signature still emitted");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent?key=${API_KEY}`;
  const noThinkBody = {
    contents: step1Contents,
    tools: [{ functionDeclarations: [TOOL_DECL] }],
    generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
  };
  const noThinkRes = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(noThinkBody) });
  const noThinkText = await noThinkRes.text();
  if (!noThinkRes.ok) {
    console.log("STEP 2'' rejected:", noThinkRes.status, noThinkText.slice(0, 300));
  } else {
    const noThinkParsed = JSON.parse(noThinkText);
    console.log("STEP 2'' parts (thinkingBudget=0):");
    describeParts(noThinkParsed.candidates?.[0]?.content?.parts ?? []);
  }
}

main().catch(e => {
  console.error('Probe failed:', e);
  process.exit(1);
});
