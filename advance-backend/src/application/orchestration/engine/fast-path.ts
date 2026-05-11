import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import type { Logger } from '../../../shared/logger';

// ─── Classification ────────────────────────────────────────────────────────

const SIMPLE_PATTERNS = [
  /^(hi|hey|hello|good\s+morning|good\s+afternoon|good\s+evening|howdy|greetings)(\s|!|\.)*$/i,
  /^thanks?(\s+you)?(\s|!|\.)*$/i,
  /^thank\s+you(\s|!|\.)*$/i,
  /^(ok|okay|got\s+it|sure|sounds\s+good|perfect|great|nice|cool|alright|noted)(\s|!|\.)*$/i,
  /^(bye|goodbye|see\s+you|ttyl|later|cya)(\s|!|\.)*$/i,
  /^who\s+are\s+you(\?|\.)*$/i,
  /^what\s+(can|do)\s+you\s+do(\?|\.)*$/i,
  /^how\s+are\s+you(\?|\.)*$/i,
  /^(what|which)\s+(day|date|time)\s+(is\s+it|today)(\?|\.)*$/i,
  /^what('s|'s|\s+is)\s+(today|the\s+date|the\s+time)(\?|\.)*$/i,
];

// Any of these words in the message → treat as complex (needs tools/data).
const BUSINESS_RE = /\b(invoice|email|report|creat|send|find|analyz|analys|schedul|meeting|task|search|fetch|list|updat|delet|draft|calendar|document|doc|spreadsheet|file|contact|lead|deal|crm|zoho|gmail|drive|approval|approv|payment|budget|export|import|summar|generat|pull|check|look\s+up|look\s+for)\b/i;

export type MessageComplexity = 'SIMPLE' | 'COMPLEX';

export function classifyMessage(text: string): MessageComplexity {
  const trimmed = text.trim();
  if (trimmed.length > 80) return 'COMPLEX';
  if (BUSINESS_RE.test(trimmed)) return 'COMPLEX';
  for (const pattern of SIMPLE_PATTERNS) {
    if (pattern.test(trimmed)) return 'SIMPLE';
  }
  return 'COMPLEX';
}

// ─── Fast-path LLM call ────────────────────────────────────────────────────

const FAST_PATH_SYSTEM = `You are Divo, a concise AI assistant embedded in Lark (a workplace chat app). \
Respond conversationally and briefly. \
You have no tools in this mode — if the user asks you to perform an action, look up data, \
create something, or access any external system, politely say you'll handle it shortly and \
ask them to send the request again. Keep responses under 3 sentences.`;

export interface FastPathInput {
  userMessage: string;
  history:     ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  model:       LanguageModel;
  log:         Logger;
}

export interface FastPathOutput {
  text: string;
}

export async function runFastPath(input: FastPathInput): Promise<FastPathOutput> {
  const startMs = Date.now();
  const { text } = await generateText({
    model:      input.model,
    system:     FAST_PATH_SYSTEM,
    messages: [
      ...input.history.map(t => ({ role: t.role as 'user' | 'assistant', content: t.content })),
      { role: 'user' as const, content: input.userMessage },
    ],
    temperature:      0.4,
    maxOutputTokens:  256,
    abortSignal:      AbortSignal.timeout(8_000),
  });
  input.log.info('fast_path.llm_done', { durationMs: Date.now() - startMs, replyLength: text.length });
  return { text: text.trim() || 'Hello! How can I help you?' };
}
