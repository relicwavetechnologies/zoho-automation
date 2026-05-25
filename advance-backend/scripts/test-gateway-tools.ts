import 'dotenv/config';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { decryptToken } from '../src/infrastructure/shared/token.crypto.js';

const MODEL = process.argv[2] || 'gpt-5.4-mini';
const ENCRYPTION_KEY = process.env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '';
const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL;

if (!GATEWAY_BASE_URL) {
  console.error('Missing GATEWAY_BASE_URL in .env');
  process.exit(1);
}

async function getDecryptedGatewayKey(): Promise<string> {
  const prisma = new PrismaClient();
  try {
    const company = await prisma.company.findFirst({
      where: { gatewayApiKey: { not: null } },
      select: { name: true, gatewayApiKey: true },
    });
    if (!company?.gatewayApiKey) throw new Error('No company with gatewayApiKey found');
    const decrypted = decryptToken(company.gatewayApiKey, ENCRYPTION_KEY);
    console.log(`Company:  ${company.name}`);
    console.log(`Key:      ${decrypted.slice(0, 12)}...`);
    return decrypted;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  console.log('=== Gateway Tool Calling Test ===');
  console.log(`Gateway:  ${GATEWAY_BASE_URL}`);
  console.log(`Model:    ${MODEL}`);
  console.log('');

  const apiKey = await getDecryptedGatewayKey();

  const gateway = createOpenAI({
    baseURL: `${GATEWAY_BASE_URL}/v1`,
    apiKey,
  });

  const weatherTool = tool({
    description: 'Get current weather for a city',
    parameters: z.object({
      city: z.string().describe('City name'),
    }),
    execute: async ({ city }) => {
      console.log(`  [tool executed] getWeather(city="${city}")`);
      return { city, temperature: 22, condition: 'sunny' };
    },
  });

  const calculatorTool = tool({
    description: 'Perform a math calculation',
    parameters: z.object({
      expression: z.string().describe('Math expression like "2+2" or "15*3"'),
    }),
    execute: async ({ expression }) => {
      console.log(`  [tool executed] calculate(expression="${expression}")`);
      try {
        const result = Function(`"use strict"; return (${expression})`)();
        return { expression, result };
      } catch {
        return { expression, result: 'error', error: 'invalid expression' };
      }
    },
  });

  // Test 1: Single tool
  console.log('--- Test 1: Single tool call ---');
  console.log(`Prompt: "What is the weather in Tokyo?"`);
  try {
    const r1 = await generateText({
      model: gateway.chat(MODEL),
      prompt: 'What is the weather in Tokyo?',
      tools: { getWeather: weatherTool },
      maxSteps: 3,
    });
    console.log(`  Steps:       ${r1.steps.length}`);
    console.log(`  Tool calls:  ${r1.toolCalls.length}`);
    for (const tc of r1.toolCalls) console.log(`    → ${tc.toolName}(${JSON.stringify(tc.args)})`);
    console.log(`  Text:        "${r1.text.slice(0, 200)}"`);
    console.log(`  Finish:      ${r1.finishReason}`);
    console.log('  ✓ PASSED\n');
  } catch (e: any) {
    console.log(`  ✗ FAILED: ${e.message?.slice(0, 300)}`);
    if (e.statusCode) console.log(`  HTTP:  ${e.statusCode}`);
    if (e.responseBody) console.log(`  Body:  ${String(e.responseBody).slice(0, 300)}`);
    console.log('');
  }

  // Test 2: Multiple tools
  console.log('--- Test 2: Multiple tools available ---');
  console.log(`Prompt: "What is 145 * 37?"`);
  try {
    const r2 = await generateText({
      model: gateway.chat(MODEL),
      prompt: 'What is 145 * 37?',
      tools: { getWeather: weatherTool, calculate: calculatorTool },
      maxSteps: 3,
    });
    console.log(`  Steps:       ${r2.steps.length}`);
    console.log(`  Tool calls:  ${r2.toolCalls.length}`);
    for (const tc of r2.toolCalls) console.log(`    → ${tc.toolName}(${JSON.stringify(tc.args)})`);
    console.log(`  Text:        "${r2.text.slice(0, 200)}"`);
    console.log(`  Finish:      ${r2.finishReason}`);
    console.log('  ✓ PASSED\n');
  } catch (e: any) {
    console.log(`  ✗ FAILED: ${e.message?.slice(0, 300)}`);
    if (e.statusCode) console.log(`  HTTP:  ${e.statusCode}`);
    if (e.responseBody) console.log(`  Body:  ${String(e.responseBody).slice(0, 300)}`);
    console.log('');
  }

  // Test 3: Multi-step
  console.log('--- Test 3: Multi-step tool use ---');
  console.log(`Prompt: "Check weather in London and tell me if I need a jacket"`);
  try {
    const r3 = await generateText({
      model: gateway.chat(MODEL),
      prompt: 'Check the weather in London and tell me if I need a jacket',
      tools: { getWeather: weatherTool },
      maxSteps: 3,
    });
    console.log(`  Steps:       ${r3.steps.length}`);
    console.log(`  Tool calls:  ${r3.toolCalls.length}`);
    for (const tc of r3.toolCalls) console.log(`    → ${tc.toolName}(${JSON.stringify(tc.args)})`);
    console.log(`  Text:        "${r3.text.slice(0, 200)}"`);
    console.log(`  Finish:      ${r3.finishReason}`);
    console.log('  ✓ PASSED\n');
  } catch (e: any) {
    console.log(`  ✗ FAILED: ${e.message?.slice(0, 300)}`);
    if (e.statusCode) console.log(`  HTTP:  ${e.statusCode}`);
    if (e.responseBody) console.log(`  Body:  ${String(e.responseBody).slice(0, 300)}`);
    console.log('');
  }

  console.log('=== Done ===');
}

main().catch(e => { console.error(e); process.exit(1); });
