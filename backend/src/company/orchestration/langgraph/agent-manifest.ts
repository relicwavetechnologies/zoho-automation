import { agentRegistry } from '../../agents';

export type AgentManifestEntry = {
    key: string;
    description: string;
};

// Descriptions for known agent keys – extend as you add agents.
const AGENT_DESCRIPTIONS: Record<string, string> = {
    'zoho-read': 'Reads CRM data (contacts, deals, accounts, leads) from Zoho.',
    'outreach-read': 'Reads outreach publisher inventory with URL and DA/DR filters.',
    'zoho-action': 'Executes approved Zoho side-effect actions through provider adapter.',
    'lark-response': 'Sends a formatted message reply to the Lark chat.',
    response: 'Generates a general-purpose text reply for the user.',
    'risk-check': 'Evaluates whether a write/destructive action is safe to proceed.',
};

/**
 * Builds the agent capability manifest from the live agent registry.
 * Only returns agents that are actually registered.
 */
export const buildAgentManifest = (): AgentManifestEntry[] => {
    const registeredKeys = agentRegistry.list();
    return registeredKeys.map((key) => ({
        key,
        description: AGENT_DESCRIPTIONS[key] ?? `Agent '${key}' — no description available.`,
    }));
};

/**
 * Formats the manifest as a concise string for injection into an LLM prompt.
 */
export const formatManifestForPrompt = (manifest: AgentManifestEntry[]): string => {
    if (manifest.length === 0) {
        return 'No agents are currently available.';
    }
    return manifest.map((entry) => `- ${entry.key}: ${entry.description}`).join('\n');
};
