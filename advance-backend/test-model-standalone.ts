/**
 * Standalone model test — same prompt, same tools, same message, zero pipeline.
 * If this also refuses to delegate, it's the model. If it delegates, it's our code.
 *
 * Usage: npx tsx test-model-standalone.ts
 */

import 'dotenv/config';
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { tool } from 'ai';

const MODEL_ID = process.env.MODEL_ID ?? 'gemini-3.1-flash-lite-preview';
const API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY!;

console.log(`\n=== STANDALONE MODEL TEST ===`);
console.log(`Model: ${MODEL_ID}`);
console.log(`API Key: ${API_KEY.slice(0, 10)}...`);

const google = createGoogleGenerativeAI({ apiKey: API_KEY });
const model = google(MODEL_ID);

// Exact same tool definitions the supervisor sees
const agentZohoOps = tool({
  description: 'Queries and manages Zoho CRM (contacts, leads, accounts, deals) and Zoho Books (invoices, bills, payments, expenses, overdue reports). Returns full datasets with exact financial figures, supports Hinglish and IST date ranges.',
  parameters: z.object({
    task: z.string().describe('Task to delegate to this agent'),
  }),
  execute: async ({ task }) => {
    console.log(`\n>>> TOOL CALLED: agent_zoho_ops`);
    console.log(`>>> Task: ${task}`);
    return 'Found 277 vendor bills for April 2026. Top 3: BILL-001 (Vendor A, ₹45,000), BILL-002 (Vendor B, ₹12,300), BILL-003 (Vendor C, ₹8,900).';
  },
});

const agentLarkOps = tool({
  description: 'Manages Lark tasks, messages, calendar events, meetings, approvals, documents, and Base tables.',
  parameters: z.object({
    task: z.string().describe('Task to delegate to this agent'),
  }),
  execute: async ({ task }) => {
    console.log(`\n>>> TOOL CALLED: agent_lark_ops`);
    console.log(`>>> Task: ${task}`);
    return 'Done.';
  },
});

const agentGoogleOps = tool({
  description: 'Handles Gmail, Google Calendar, and Google Drive.',
  parameters: z.object({
    task: z.string().describe('Task to delegate to this agent'),
  }),
  execute: async ({ task }) => {
    console.log(`\n>>> TOOL CALLED: agent_google_ops`);
    console.log(`>>> Task: ${task}`);
    return 'Done.';
  },
});

const agentContextAgent = tool({
  description: 'Retrieval-only agent — searches knowledge base, contacts, files, and the live web.',
  parameters: z.object({
    task: z.string().describe('Task to delegate to this agent'),
  }),
  execute: async ({ task }) => {
    console.log(`\n>>> TOOL CALLED: agent_context_agent`);
    console.log(`>>> Task: ${task}`);
    return 'No results found.';
  },
});

// Exact same system prompt from the DB (with fresh date)
const systemPrompt = `You are Divo — a sharp, direct AI assistant embedded in Lark.
Current date/time: ${new Date().toISOString()}

WHO YOU ARE:
- You work inside Lark alongside the team. You are helpful, direct, and treat everyone as a capable adult.
- Confirm actions in 1–2 sentences. No paragraphs for simple tasks.
- Do not expose tool names, agent names, or internal IDs in replies.

AGENT ROUTING RULES — call the correct agent, top rule wins:
1. Tasks, meetings, schedule, calendar events, messages, docs, Base, approvals → agent_lark_ops
2. Gmail, Google Drive → agent_google_ops
3. CRM: contacts, leads, accounts, deals, Zoho CRM → agent_zoho_ops (use the "CRM:" prefix in task)
4. Finance: invoices, bills, payments, balances, Zoho Books → agent_zoho_ops (use the "BOOKS:" prefix in task)
5. Internal documents, past conversations, knowledge base → agent_context_agent

REPLY RULES:
- ALWAYS call the appropriate agent tool first. Never assume a tool is unavailable — try it. If the call returns an error, THEN tell the user what went wrong.
- For simple single-agent tasks: confirm in 1–2 sentences with the key detail.
- Do NOT say what you're about to do before doing it — just do it.`;

const userMessage = 'The PDFs of vendor bills added in Zoho in april 2026 also need to be checked to verify whether any expenses related to March have been booked in April or any subsequent months';

(async () => {
  console.log(`\n--- System prompt (${systemPrompt.length} chars) ---`);
  console.log(systemPrompt);
  console.log(`\n--- User message ---`);
  console.log(userMessage);
  console.log(`\n--- Running generateText... ---\n`);

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: userMessage,
      tools: {
        agent_zoho_ops: agentZohoOps,
        agent_lark_ops: agentLarkOps,
        agent_google_ops: agentGoogleOps,
        agent_context_agent: agentContextAgent,
      },
      maxSteps: 5,
      temperature: 0,
    });

    console.log(`\n--- RESULT ---`);
    console.log(`Text: ${result.text}`);
    console.log(`Steps: ${result.steps.length}`);
    console.log(`Tool calls: ${result.steps.flatMap(s => s.toolCalls.map(tc => tc.toolName)).join(', ') || 'NONE'}`);
    console.log(`Finish reason: ${result.finishReason}`);
  } catch (e) {
    console.error(`\n--- ERROR ---`);
    console.error(e);
  }
})();
