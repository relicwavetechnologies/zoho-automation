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
        'You are a fast greeter/triage assistant. Decide if the user request can be answered immediately.',
        'If yes (greeting, chitchat, very simple factual question), reply with:',
        '  {"done":true,"reply":"<your response here>"}',
        'If the request requires actions, data lookups, or complex reasoning, reply with:',
        '  {"done":false}',
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
        'You are the orchestration supervisor. You decide which agent to call next, or whether we are done.',
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
        '- If we have enough information to answer the user, return: {"next":"FINISH","reply":"<natural language response>"}',
        '- The reply should directly answer the user in a friendly, concise way. Use data from prior results.',
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
