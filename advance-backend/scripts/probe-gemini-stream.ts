/**
 * Probe raw Gemini streaming SSE chunks to see exactly how thoughtSignature
 * is delivered for function calls.
 *
 * Run: pnpm tsx scripts/probe-gemini-stream.ts
 */
import 'dotenv/config';

const apiKey   = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
const MODEL_ID = process.env['MODEL_ID'] ?? 'gemini-3.1-flash-lite-preview';
if (!apiKey) { console.error('Missing API key'); process.exit(1); }

const TOOL = {
  name: 'create_task',
  description: 'Create a task',
  parameters: {
    type: 'object',
    properties: { title: { type: 'string' }, assignee: { type: 'string' } },
    required: ['title'],
  },
};

async function main() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Create a task titled "Visa" assigned to Anish.' }] }],
    tools: [{ functionDeclarations: [TOOL] }],
    generationConfig: { temperature: 0 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    console.error('HTTP', res.status, await res.text());
    process.exit(1);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let chunkIdx = 0;
  console.log(`\n=== Streaming chunks from ${MODEL_ID} ===\n`);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        chunkIdx++;
        const parts = parsed.candidates?.[0]?.content?.parts ?? [];
        console.log(`chunk ${chunkIdx}: ${parts.length} parts`);
        parts.forEach((p: any, i: number) => {
          const keys  = Object.keys(p).join(',');
          const fc    = p.functionCall ? `name=${p.functionCall.name ?? '∅'} args=${JSON.stringify(p.functionCall.args ?? p.functionCall.partialArgs ?? '∅').slice(0, 60)} willContinue=${p.functionCall.willContinue ?? '∅'}` : '';
          const txt   = p.text != null ? `text="${String(p.text).slice(0, 30)}" len=${String(p.text).length} thought=${p.thought ?? false}` : '';
          const sig   = p.thoughtSignature ? `SIG(len=${String(p.thoughtSignature).length})` : 'no-sig';
          console.log(`  [${i}] keys={${keys}} ${fc}${txt}  ${sig}`);
        });
      } catch (e) { /* ignore parse errors of partial data */ }
    }
  }
  console.log(`\n=== ${chunkIdx} chunks total ===`);
}

main();
