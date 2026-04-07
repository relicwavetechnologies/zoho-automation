import { companyAgentProfileService } from '../../agent-profiles/agent-profile.service';
import { DOMAIN_TO_TOOL_IDS, TOOL_REGISTRY_MAP } from '../../tools/tool-registry';
import type { VercelRuntimeRequestContext } from '../vercel/types';
import type { SupervisorAgentDescriptor, SupervisorAgentId } from './types';

const dedupe = (values: string[]): string[] => Array.from(new Set(values));
const areSameSet = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((value) => right.includes(value));

const isSendLike = (value?: string | null): boolean =>
  /\b(send|email|mail|draft|reply|forward|calendar|meeting|invite)\b/i.test(value ?? '');

const resolveToolDomains = (toolIds: string[]): string[] =>
  dedupe(
    toolIds.flatMap((toolId) => {
      const entry = TOOL_REGISTRY_MAP.get(toolId);
      return entry?.domain ? [entry.domain] : [];
    }),
  );

const resolvePreferredByDomain = (eligibleAgents: SupervisorAgentDescriptor[], domain?: string | null): string[] => {
  if (!domain) {
    return [];
  }
  return eligibleAgents
    .filter((agent) => agent.domainIds.includes(domain))
    .map((agent) => agent.id);
};

export const buildSupervisorAgentCatalog = async (input: {
  companyId: string;
  allowedToolIds: string[];
}): Promise<SupervisorAgentDescriptor[]> => {
  const allowed = new Set(input.allowedToolIds);
  const profiles = await companyAgentProfileService.resolveRuntimeProfiles(input.companyId);
  return profiles
    .map((profile) => ({
      id: profile.id,
      label: profile.name,
      description: profile.description,
      domainIds: resolveToolDomains(profile.toolIds),
      toolIds: profile.toolIds.filter((toolId) => allowed.has(toolId) && TOOL_REGISTRY_MAP.get(toolId)?.deprecated !== true),
      systemPrompt: profile.systemPrompt,
      modelKey: profile.modelKey,
      routingHints: profile.routingHints,
      isSeeded: profile.isSeeded,
    }))
    .filter((profile) => profile.toolIds.length > 0);
};

export const resolveSupervisorEligibleAgents = async (input: {
  runtime: Pick<
    VercelRuntimeRequestContext,
    | 'companyId'
    | 'departmentId'
    | 'allowedToolIds'
    | 'runExposedToolIds'
    | 'plannerChosenOperationClass'
    | 'workspace'
    | 'defaultAgentProfileId'
    | 'specialistAgentProfileIds'
  >;
  latestUserMessage: string;
  inferredDomain?: string | null;
  inferredOperationClass?: string | null;
  normalizedIntent?: string | null;
}): Promise<{
  eligibleAgents: SupervisorAgentDescriptor[];
  preferredAgentIds: SupervisorAgentId[];
}> => {
  const catalog = await companyAgentProfileService.resolveDepartmentAssignments({
    companyId: input.runtime.companyId,
    departmentId: input.runtime.departmentId,
    defaultAgentProfileId: input.runtime.defaultAgentProfileId,
    specialistAgentProfileIds: input.runtime.specialistAgentProfileIds,
    allowedToolIds: input.runtime.allowedToolIds,
    runExposedToolIds: input.runtime.runExposedToolIds,
    inferredDomain: input.inferredDomain,
    latestUserMessage: input.latestUserMessage,
    workspaceAvailable: Boolean(input.runtime.workspace),
  });
  const eligibleAgents = catalog.eligibleProfiles.map((profile) => ({
    id: profile.id,
    label: profile.name,
    description: profile.description,
    domainIds: resolveToolDomains(profile.toolIds),
    toolIds: profile.toolIds,
    systemPrompt: profile.systemPrompt,
    modelKey: profile.modelKey,
    routingHints: profile.routingHints,
    isSeeded: profile.isSeeded,
  }));
  const runScoped = new Set(input.runtime.runExposedToolIds ?? []);
  const useRunScopedMatch =
    runScoped.size > 0
    && !areSameSet(Array.from(runScoped), input.runtime.allowedToolIds);
  const matched = useRunScopedMatch
    ? eligibleAgents.filter((agent) => agent.toolIds.some((toolId) => runScoped.has(toolId)))
    : [];
  const finalEligible = matched.length > 0 ? matched : eligibleAgents;
  const preferred = new Set<string>(catalog.preferredProfileIds.filter((id) => finalEligible.some((agent) => agent.id === id)));

  for (const agentId of resolvePreferredByDomain(finalEligible, input.inferredDomain)) {
    preferred.add(agentId);
  }

  const sendLike = (input.inferredOperationClass ?? input.runtime.plannerChosenOperationClass)?.toLowerCase() === 'send'
    || isSendLike(input.normalizedIntent)
    || isSendLike(input.latestUserMessage);
  if (sendLike) {
    const sendAgents = finalEligible.filter((agent) =>
      agent.domainIds.some((domain) => ['gmail', 'google_calendar', 'google_drive', 'lark_message', 'lark_calendar', 'lark_meeting'].includes(domain)),
    );
    for (const agent of sendAgents) {
      preferred.add(agent.id);
    }
  }

  if (preferred.size === 0 && finalEligible[0]) {
    preferred.add(finalEligible[0].id);
  }

  return {
    eligibleAgents: finalEligible,
    preferredAgentIds: Array.from(preferred),
  };
};

export const resolveSupervisorAgentToolIds = async (input: {
  companyId: string;
  agentId: SupervisorAgentId;
  allowedToolIds: string[];
}): Promise<string[]> => {
  const catalog = await buildSupervisorAgentCatalog({
    companyId: input.companyId,
    allowedToolIds: input.allowedToolIds,
  });
  return catalog.find((agent) => agent.id === input.agentId)?.toolIds ?? [];
};

export const SUPERVISOR_AGENT_TOOL_IDS: Record<string, string[]> = Object.fromEntries(
  Object.entries(DOMAIN_TO_TOOL_IDS).map(([domain, toolIds]) => [domain, dedupe(toolIds)]),
);

export const deriveEligibleSupervisorAgents = resolveSupervisorEligibleAgents;
export const getSupervisorAgentToolIds = resolveSupervisorAgentToolIds;
