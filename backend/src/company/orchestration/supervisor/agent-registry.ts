import { DOMAIN_TO_TOOL_IDS, TOOL_REGISTRY_MAP } from '../../tools/tool-registry';
import type { VercelRuntimeRequestContext } from '../vercel/types';
import type { SupervisorAgentDescriptor, SupervisorAgentId } from './types';

const dedupe = (values: string[]): string[] => Array.from(new Set(values));
const areSameSet = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((value) => right.includes(value));

const AGENT_DOMAIN_MAP: Record<SupervisorAgentId, { label: string; description: string; domains: string[] }> = {
  'lark-ops-agent': {
    label: 'Lark Ops Agent',
    description: 'Handles Lark tasks, messages, calendar, meetings, approvals, docs, and base collaboration operations.',
    domains: ['lark_task', 'lark_message', 'lark_calendar', 'lark_meeting', 'lark_approval', 'lark_doc', 'lark_base'],
  },
  'google-workspace-agent': {
    label: 'Google Workspace Agent',
    description: 'Handles Gmail, Google Calendar, and Google Drive work.',
    domains: ['gmail', 'google_calendar', 'google_drive'],
  },
  'zoho-ops-agent': {
    label: 'Zoho Ops Agent',
    description: 'Handles Zoho Books and Zoho CRM operations.',
    domains: ['zoho_books', 'zoho_crm'],
  },
  'context-agent': {
    label: 'Context Agent',
    description: 'Handles all retrieval through the unified context broker, plus outreach lookup and contact/context resolution.',
    domains: ['context_search', 'outreach', 'general'],
  },
  'workspace-agent': {
    label: 'Workspace Agent',
    description: 'Handles workflows, coding, repo inspection, OCR, and document parsing.',
    domains: ['workflow', 'workspace', 'document_inspection'],
  },
};

const resolveToolIdsForDomains = (domains: string[], allowedToolIds: string[]): string[] => {
  const allowed = new Set(allowedToolIds);
  const active = dedupe(
    domains.flatMap((domain) =>
      (DOMAIN_TO_TOOL_IDS[domain] ?? []).filter((toolId) =>
        allowed.has(toolId) && TOOL_REGISTRY_MAP.get(toolId)?.deprecated !== true)),
  );
  if (active.length > 0) {
    return active;
  }
  return dedupe(
    domains.flatMap((domain) => (DOMAIN_TO_TOOL_IDS[domain] ?? []).filter((toolId) => allowed.has(toolId))),
  );
};

export const buildSupervisorAgentCatalog = (input: {
  allowedToolIds: string[];
}): SupervisorAgentDescriptor[] =>
  (Object.entries(AGENT_DOMAIN_MAP) as Array<
    [SupervisorAgentId, { label: string; description: string; domains: string[] }]
  >)
    .map(([id, config]) => ({
      id,
      label: config.label,
      description: config.description,
      domainIds: config.domains,
      toolIds: resolveToolIdsForDomains(config.domains, input.allowedToolIds),
    }))
    .filter((entry) => entry.toolIds.length > 0);

const isSendLike = (value?: string | null): boolean =>
  /\b(send|email|mail|draft|reply|forward|calendar|meeting|invite)\b/i.test(value ?? '');

const resolveAgentForDomainHint = (domain?: string | null): SupervisorAgentId | null => {
  switch (domain) {
    case 'lark_task':
    case 'lark_message':
    case 'lark_calendar':
    case 'lark_meeting':
    case 'lark_approval':
    case 'lark_doc':
    case 'lark_base':
    case 'lark':
      return 'lark-ops-agent';
    case 'gmail':
    case 'google_calendar':
    case 'google_drive':
      return 'google-workspace-agent';
    case 'zoho_books':
    case 'zoho_crm':
      return 'zoho-ops-agent';
    case 'context_search':
    case 'web_search':
    case 'skill':
    case 'outreach':
    case 'general':
      return 'context-agent';
    case 'workflow':
    case 'workspace':
    case 'document_inspection':
      return 'workspace-agent';
    default:
      return null;
  }
};

export const resolveSupervisorEligibleAgents = (input: {
  runtime: Pick<
    VercelRuntimeRequestContext,
    'allowedToolIds' | 'runExposedToolIds' | 'plannerChosenOperationClass' | 'workspace'
  >;
  latestUserMessage: string;
  inferredDomain?: string | null;
  inferredOperationClass?: string | null;
  normalizedIntent?: string | null;
}): {
  eligibleAgents: SupervisorAgentDescriptor[];
  preferredAgentIds: SupervisorAgentId[];
} => {
  const catalog = buildSupervisorAgentCatalog({ allowedToolIds: input.runtime.allowedToolIds });
  const runScoped = new Set(input.runtime.runExposedToolIds ?? []);
  const useRunScopedMatch =
    runScoped.size > 0
    && !areSameSet(Array.from(runScoped), input.runtime.allowedToolIds);
  const matched = useRunScopedMatch
    ? catalog.filter((agent) => agent.toolIds.some((toolId) => runScoped.has(toolId)))
    : [];
  const eligibleAgents = matched.length > 0 ? matched : catalog;
  const preferred = new Set<SupervisorAgentId>(matched.map((agent) => agent.id));

  const domainHintAgent = resolveAgentForDomainHint(input.inferredDomain);
  if (domainHintAgent && eligibleAgents.some((agent) => agent.id === domainHintAgent)) {
    preferred.add(domainHintAgent);
  }

  const contextAgent = eligibleAgents.find((agent) => agent.id === 'context-agent');
  if (
    contextAgent
    && (
      domainHintAgent === 'context-agent'
      || (!domainHintAgent && preferred.size === 0)
    )
  ) {
    preferred.add(contextAgent.id);
  }
  const workspaceAgent = eligibleAgents.find((agent) => agent.id === 'workspace-agent');
  if (workspaceAgent && input.runtime.workspace) {
    preferred.add(workspaceAgent.id);
  }
  const googleAgent = eligibleAgents.find((agent) => agent.id === 'google-workspace-agent');
  if (
    googleAgent &&
    ((input.inferredOperationClass ?? input.runtime.plannerChosenOperationClass)?.toLowerCase() === 'send'
      || isSendLike(input.normalizedIntent)
      || isSendLike(input.latestUserMessage))
  ) {
    preferred.add(googleAgent.id);
  }

  return {
    eligibleAgents,
    preferredAgentIds: Array.from(preferred),
  };
};

export const resolveSupervisorAgentToolIds = (input: {
  agentId: SupervisorAgentId;
  allowedToolIds: string[];
}): string[] => {
  const config = AGENT_DOMAIN_MAP[input.agentId];
  return resolveToolIdsForDomains(config.domains, input.allowedToolIds);
};

export const SUPERVISOR_AGENT_TOOL_IDS: Record<SupervisorAgentId, string[]> = (
  Object.keys(AGENT_DOMAIN_MAP) as SupervisorAgentId[]
).reduce((acc, agentId) => {
  acc[agentId] = dedupe(
    AGENT_DOMAIN_MAP[agentId].domains.flatMap((domain) => DOMAIN_TO_TOOL_IDS[domain] ?? []),
  );
  return acc;
}, {} as Record<SupervisorAgentId, string[]>);

export const deriveEligibleSupervisorAgents = resolveSupervisorEligibleAgents;
export const getSupervisorAgentToolIds = resolveSupervisorAgentToolIds;
