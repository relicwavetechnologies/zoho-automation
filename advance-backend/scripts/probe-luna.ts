/**
 * probe-luna — check that gpt-5.6-luna actually answers with the configured key.
 *
 * The catalogue entry, the proxy routing and the container plumbing are all
 * unit-tested, but every one of those tests asserts against our own idea of the
 * model. This asks the provider. It sends the exact request the proxy forwards —
 * same URL shape, same canonical model id, same chat-completions body — so a
 * wrong id, a rejected key, or a model that does not accept image parts fails
 * here rather than inside a Lark run.
 *
 * The image turn is the point of the second call: Luna is in the catalogue as
 * the one model that can see, and nothing else we run proves that claim.
 *
 * Usage:
 *   pnpm tsx scripts/probe-luna.ts
 *   pnpm tsx scripts/probe-luna.ts --text-only
 */
import 'dotenv/config';
import { deflateSync } from 'node:zlib';
import { loadAndValidateEnv } from '../src/config/env';
import { canonicalModel, providerOf, supportsVision } from '../src/application/observability/pricing';

const MODEL = canonicalModel('gpt-5.6-luna');

/** A solid-colour PNG, built here so the probe carries no fixture file. */
export function solidPng(size: number, rgb: [number, number, number]): Buffer {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[row + 1 + x * 3] = rgb[0];
      raw[row + 2 + x * 3] = rgb[1];
      raw[row + 3 + x * 3] = rgb[2];
    }
  }

  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
    return Buffer.concat([head, data, tail]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface Completion {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string };
}

async function ask(
  baseUrl: string,
  apiKey: string,
  label: string,
  content: unknown,
): Promise<void> {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content }],
      stream: false,
    }),
  });

  const body = await response.text();
  let parsed: Completion = {};
  try { parsed = JSON.parse(body) as Completion; } catch { /* non-JSON upstream error */ }

  if (!response.ok) {
    const reason = parsed.error?.message ?? body.slice(0, 300);
    throw new Error(`${label} failed (HTTP ${response.status}): ${reason}`);
  }

  const answer = parsed.choices?.[0]?.message?.content?.trim() ?? '';
  if (!answer) throw new Error(`${label} returned no content`);

  console.log(`  ${label.padEnd(6)} ok   ${Date.now() - startedAt}ms  `
    + `in=${parsed.usage?.prompt_tokens ?? '?'} out=${parsed.usage?.completion_tokens ?? '?'}`);
  console.log(`         ${answer.replace(/\s+/g, ' ').slice(0, 160)}`);
}

async function main(): Promise<void> {
  const env = loadAndValidateEnv(process.env);
  const provider = providerOf(MODEL);
  if (provider !== 'openai') throw new Error(`${MODEL} resolved to provider ${provider}`);

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  console.log(`probing ${MODEL} at ${env.OPENAI_BASE_URL} (key …${apiKey.slice(-4)})`);

  await ask(env.OPENAI_BASE_URL, apiKey, 'text', 'Reply with exactly: ready');

  if (process.argv.includes('--text-only')) return;
  if (!supportsVision(MODEL)) throw new Error(`${MODEL} is not marked as a vision model`);

  const png = solidPng(64, [220, 20, 60]);
  await ask(env.OPENAI_BASE_URL, apiKey, 'image', [
    { type: 'text', text: 'What colour fills this image? Answer with one word.' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
  ]);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('PROBE FAILED:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
