import { extractJsonObject } from '../langchain';
import type { AgentManifestEntry } from './agent-manifest';

// What the Tier-1 (Groq) classifier returns.
export type Tier1Decision =
    | { done: true; reply: string }
    | { done: false };

// What the Tier-2 supervisor boss returns each loop iteration.
export type SupervisorDecision =
    | { next: string; finish: false }               // call this agent next
    | { next: 'FINISH'; finish: true; reply: string }; // done — send this reply

// ─── Tier-1 ─────────────────────────────────────────────────────────────────

export const buildTier1Prompt = (messageText: string): string =>
    [
        'You are Odin AI fast-path triage.',
        'Decide whether the user request can be answered immediately without orchestration.',
        'Only fast-path greetings, small talk, or very simple capability questions.',
        'Do not fast-path requests that need tools, data lookup, planning, or multi-step reasoning.',
        'If it can be answered immediately, return {"done":true,"reply":"<short reply>"}',
        'If it requires orchestration, return {"done":false}',
        'Valid example: {"done":true,"reply":"Hello. How can I help?"}',
        'Invalid example to avoid: I should route this.',
        'Return JSON only. No extra text.',
        `User: ${messageText}`,
    ].join('\n');

const parseTier1Output = (raw: string | null): Tier1Decision => {
    if (!raw) return { done: false };
    const parsed = extractJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') return { done: false };
    if (parsed.done === true && typeof parsed.reply === 'string' && parsed.reply.trim().length > 0) {
        return { done: true, reply: parsed.reply.trim() };
    }
    return { done: false };
};

export const resolveTier1Decision = (rawLlmOutput: string | null): Tier1Decision =>
    parseTier1Output(rawLlmOutput);

// ─── Tier-2 Supervisor ───────────────────────────────────────────────────────

export const buildSupervisorPrompt = (input: {
    messageText: string;
    manifest: AgentManifestEntry[];
    priorResults: { agentKey: string; status: string; summary: string }[];
}): string => {
    const agentList = input.manifest.length > 0
        ? input.manifest.map((a) => `- ${a.key}: ${a.description}`).join('\n')
        : '- (no agents available)';

    const history = input.priorResults.length > 0
        ? input.priorResults.map((r) => `- ${r.agentKey} [${r.status}]: ${r.summary}`).join('\n')
        : '(none yet)';

    return [
        'You are Odin AI orchestration supervisor.',
        'Decide which agent should run next, or whether the user already has enough grounded information.',
        'Call exactly one next agent or finish the task.',
        'Do not invent new capabilities beyond the available agent list.',
        'Treat the available agent list as the complete live runtime surface for this task.',
        'Do not claim work completed unless the prior results already prove it.',
        'Unless a dedicated Lark agent is explicitly listed, assume current Lark operational support is limited to Lark Docs export/edit and Lark chat delivery only.',
        'Do not imply support for Lark Tasks, Base, Calendar, Meetings, Minutes, or approvals unless those agents are actually present in the available list.',
        '',
        'Available agents:',
        agentList,
        '',
        'Agents already run this turn:',
        history,
        '',
        'User request:',
        input.messageText,
        '',
        'Instructions:',
        '- If more work is needed, pick the best agent from the list and return: {"next":"<agentKey>"}',
        '- If we have enough information to answer the user, return: {"next":"FINISH","reply":"<concise grounded response>"}',
        '- Keep the finish reply concise and grounded in prior results.',
        '- Valid example: {"next":"search-read"} is invalid if that key is not in the available list. Use only listed agent keys.',
        '- Valid example: {"next":"FINISH","reply":"I found 2 recent Zoho deals and 1 stalled renewal."}',
        '- Invalid example to avoid: I think we are done.',
        '- Return JSON only. No extra text.',
    ].join('\n');
};

const parseSupervisorOutput = (
    raw: string | null,
    availableKeys: string[],
    fallbackReply: string,
): SupervisorDecision => {
    if (!raw) return { next: 'FINISH', finish: true, reply: fallbackReply };

    const parsed = extractJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') {
        return { next: 'FINISH', finish: true, reply: fallbackReply };
    }

    if (typeof parsed.next !== 'string') {
        return { next: 'FINISH', finish: true, reply: fallbackReply };
    }

    if (parsed.next === 'FINISH') {
        const reply = typeof parsed.reply === 'string' && parsed.reply.trim().length > 0
            ? parsed.reply.trim()
            : fallbackReply;
        return { next: 'FINISH', finish: true, reply };
    }

    if (availableKeys.includes(parsed.next)) {
        return { next: parsed.next, finish: false };
    }

    // Unknown agent key — finish gracefully
    return { next: 'FINISH', finish: true, reply: fallbackReply };
};

export const resolveSupervisorDecision = (input: {
    rawLlmOutput: string | null;
    availableAgentKeys: string[];
    fallbackReply: string;
}): SupervisorDecision =>
    parseSupervisorOutput(input.rawLlmOutput, input.availableAgentKeys, input.fallbackReply);
