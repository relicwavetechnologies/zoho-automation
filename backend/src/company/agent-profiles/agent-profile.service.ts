import { createHash, randomUUID } from 'crypto';

import { prisma } from '../../utils/prisma';
import { ACTIVE_TOOL_REGISTRY, DOMAIN_TO_TOOL_IDS } from '../tools/tool-registry';
import { companyAgentProfileCache, type CompanyAgentProfileRuntime } from './agent-profile.cache';

type UpsertCompanyAgentProfileInput = {
  companyId: string;
  actorUserId: string;
  profileId?: string;
  slug: string;
  name: string;
  description?: string | null;
  systemPrompt: string;
  modelKey: string;
  toolIds: string[];
  routingHints: string[];
  departmentIds: string[];
  isActive?: boolean;
};

type UpsertDepartmentManagedProfileInput = {
  companyId: string;
  departmentId: string;
  actorUserId: string;
  departmentName: string;
  departmentSlug: string;
  currentProfileId?: string;
  systemPrompt: string;
  modelKey: string;
  toolIds: string[];
};

export type DepartmentAgentAssignmentRuntime = {
  defaultAgentProfileId?: string;
  specialistAgentProfileIds: string[];
};

const normalizeText = (value: string | null | undefined): string =>
  (value ?? '').replace(/\r\n?/g, '\n').trim();

const normalizeSlug = (value: string | null | undefined): string =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const uniq = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));

const ACTIVE_VERCEL_TOOL_IDS = new Set(
  ACTIVE_TOOL_REGISTRY.filter((tool) => tool.engines.includes('vercel')).map((tool) => tool.id),
);

const normalizeToolIds = (toolIds: Array<string | null | undefined>): string[] =>
  uniq(toolIds).filter((toolId) => ACTIVE_VERCEL_TOOL_IDS.has(toolId));

const buildDepartmentManagedProfileSlug = (departmentSlug: string): string =>
  `${normalizeSlug(departmentSlug) || 'department'}-agent`;

const buildRevisionHash = (
  input: Omit<CompanyAgentProfileRuntime, 'revisionHash'>,
): string =>
  createHash('sha1')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 12);

const toRuntimeProfile = (input: {
  id: string;
  companyId: string;
  slug: string;
  name: string;
  description?: string | null;
  systemPrompt: string;
  modelKey: string;
  toolIds: string[];
  routingHints?: string[] | null;
  departmentIds?: string[] | null;
  isActive?: boolean | null;
  isSeeded?: boolean | null;
}): CompanyAgentProfileRuntime => {
  const runtime = {
    id: input.id,
    companyId: input.companyId,
    slug: normalizeSlug(input.slug),
    name: normalizeText(input.name),
    description: normalizeText(input.description),
    systemPrompt: normalizeText(input.systemPrompt),
    modelKey: normalizeText(input.modelKey) || 'gemini-3.1-flash-lite-preview',
    toolIds: normalizeToolIds(input.toolIds),
    routingHints: uniq(input.routingHints ?? []),
    departmentIds: uniq(input.departmentIds ?? []),
    isActive: input.isActive ?? true,
    isSeeded: input.isSeeded ?? false,
  };
  return {
    ...runtime,
    revisionHash: buildRevisionHash(runtime),
  };
};

const seedCatalog = (companyId: string): CompanyAgentProfileRuntime[] => {
  const base = [
    {
      id: 'seed:lark-ops-agent',
      slug: 'lark-ops-agent',
      name: 'Lark Ops Agent',
      description: 'Handles Lark tasks, messages, calendar, meetings, approvals, docs, and collaboration operations.',
      systemPrompt: 'Specialize in Lark operations and use only the assigned Lark tools.',
      modelKey: 'gemini-3.1-flash-lite-preview',
      toolIds: uniq([
        ...(DOMAIN_TO_TOOL_IDS.lark_task ?? []),
        ...(DOMAIN_TO_TOOL_IDS.lark_message ?? []),
        ...(DOMAIN_TO_TOOL_IDS.lark_calendar ?? []),
        ...(DOMAIN_TO_TOOL_IDS.lark_meeting ?? []),
        ...(DOMAIN_TO_TOOL_IDS.lark_approval ?? []),
        ...(DOMAIN_TO_TOOL_IDS.lark_doc ?? []),
        ...(DOMAIN_TO_TOOL_IDS.lark_base ?? []),
      ]),
      routingHints: ['lark', 'task', 'calendar', 'meeting', 'approval', 'docs'],
    },
    {
      id: 'seed:google-workspace-agent',
      slug: 'google-workspace-agent',
      name: 'Google Workspace Agent',
      description: 'Handles Gmail, Google Calendar, and Google Drive work.',
      systemPrompt: 'Specialize in Google Workspace operations and use only the assigned Google tools.',
      modelKey: 'gemini-3.1-flash-lite-preview',
      toolIds: uniq([
        ...(DOMAIN_TO_TOOL_IDS.gmail ?? []),
        ...(DOMAIN_TO_TOOL_IDS.google_calendar ?? []),
        ...(DOMAIN_TO_TOOL_IDS.google_drive ?? []),
      ]),
      routingHints: ['gmail', 'email', 'drive', 'calendar'],
    },
    {
      id: 'seed:zoho-ops-agent',
      slug: 'zoho-ops-agent',
      name: 'Zoho Ops Agent',
      description: 'Handles Zoho Books and Zoho CRM operations.',
      systemPrompt: 'Specialize in Zoho operations and use only the assigned Zoho tools.',
      modelKey: 'gemini-3.1-flash-lite-preview',
      toolIds: uniq([
        ...(DOMAIN_TO_TOOL_IDS.zoho_books ?? []),
        ...(DOMAIN_TO_TOOL_IDS.zoho_crm ?? []),
      ]),
      routingHints: ['zoho', 'books', 'crm', 'invoice', 'deals'],
    },
    {
      id: 'seed:context-agent',
      slug: 'context-agent',
      name: 'Context Agent',
      description: 'Handles retrieval through context, history, files, and search.',
      systemPrompt: 'Specialize in retrieval and cross-source lookup with the assigned context tools.',
      modelKey: 'gemini-3.1-flash-lite-preview',
      toolIds: uniq([
        ...(DOMAIN_TO_TOOL_IDS.context_search ?? []),
        ...(DOMAIN_TO_TOOL_IDS.general ?? []),
        ...(DOMAIN_TO_TOOL_IDS.outreach ?? []),
        ...(DOMAIN_TO_TOOL_IDS.skill ?? []),
        ...(DOMAIN_TO_TOOL_IDS.web_search ?? []),
      ]),
      routingHints: ['history', 'search', 'context', 'files', 'lookup'],
    },
    {
      id: 'seed:workspace-agent',
      slug: 'workspace-agent',
      name: 'Workspace Agent',
      description: 'Handles workflows, coding, repo inspection, and document parsing.',
      systemPrompt: 'Specialize in workspace, workflow, and document operations with the assigned tools.',
      modelKey: 'gemini-3.1-flash-lite-preview',
      toolIds: uniq([
        ...(DOMAIN_TO_TOOL_IDS.workflow ?? []),
        ...(DOMAIN_TO_TOOL_IDS.workspace ?? []),
        ...(DOMAIN_TO_TOOL_IDS.document_inspection ?? []),
      ]),
      routingHints: ['workspace', 'code', 'workflow', 'document', 'ocr'],
    },
  ];

  return base.map((entry) => toRuntimeProfile({
    id: entry.id,
    companyId,
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    systemPrompt: entry.systemPrompt,
    modelKey: entry.modelKey,
    toolIds: entry.toolIds,
    routingHints: entry.routingHints,
    departmentIds: [],
    isActive: true,
    isSeeded: true,
  }));
};

class CompanyAgentProfileService {
  private async reserveUniqueSlug(input: {
    companyId: string;
    desiredSlug: string;
    excludeProfileId?: string;
  }): Promise<string> {
    const baseSlug = normalizeSlug(input.desiredSlug) || 'agent';
    let slug = baseSlug;
    let suffix = 2;
    for (;;) {
      const existing = await prisma.companyAgentProfile.findFirst({
        where: {
          companyId: input.companyId,
          slug,
          ...(input.excludeProfileId ? { id: { not: input.excludeProfileId } } : {}),
        },
        select: { id: true },
      });
      if (!existing) {
        return slug;
      }
      slug = `${baseSlug}-${suffix++}`;
    }
  }

  private async fetchStoredProfiles(companyId: string) {
    return prisma.companyAgentProfile.findMany({
      where: { companyId },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }, { name: 'asc' }],
    });
  }

  async resolveRuntimeProfiles(companyId: string): Promise<CompanyAgentProfileRuntime[]> {
    const cached = await companyAgentProfileCache.get(companyId);
    if (cached) {
      return cached.filter((profile) => profile.isActive);
    }
    const stored = await this.fetchStoredProfiles(companyId);
    const normalized = stored.length > 0
      ? stored.map((profile) => toRuntimeProfile(profile)).filter((profile) => profile.isActive)
      : seedCatalog(companyId);
    await companyAgentProfileCache.set(companyId, normalized);
    return normalized;
  }

  async getAdminProfiles(companyId: string): Promise<CompanyAgentProfileRuntime[]> {
    const stored = await this.fetchStoredProfiles(companyId);
    if (stored.length === 0) {
      return seedCatalog(companyId);
    }
    return stored.map((profile) => toRuntimeProfile(profile));
  }

  async upsertProfile(input: UpsertCompanyAgentProfileInput): Promise<CompanyAgentProfileRuntime> {
    const normalized = toRuntimeProfile({
      id: input.profileId ?? randomUUID(),
      companyId: input.companyId,
      slug: input.slug,
      name: input.name,
      description: input.description,
      systemPrompt: input.systemPrompt,
      modelKey: input.modelKey,
      toolIds: input.toolIds,
      routingHints: input.routingHints,
      departmentIds: input.departmentIds,
      isActive: input.isActive ?? true,
      isSeeded: false,
    });

    const saved = input.profileId
      ? await prisma.companyAgentProfile.update({
          where: { id: input.profileId },
          data: {
            slug: normalized.slug,
            name: normalized.name,
            description: normalized.description,
            systemPrompt: normalized.systemPrompt,
            modelKey: normalized.modelKey,
            toolIds: normalized.toolIds,
            routingHints: normalized.routingHints,
            departmentIds: normalized.departmentIds,
            isActive: normalized.isActive,
            updatedBy: input.actorUserId,
          },
        })
      : await prisma.companyAgentProfile.create({
          data: {
            companyId: input.companyId,
            slug: normalized.slug,
            name: normalized.name,
            description: normalized.description,
            systemPrompt: normalized.systemPrompt,
            modelKey: normalized.modelKey,
            toolIds: normalized.toolIds,
            routingHints: normalized.routingHints,
            departmentIds: normalized.departmentIds,
            isActive: normalized.isActive,
            createdBy: input.actorUserId,
            updatedBy: input.actorUserId,
          },
        });

    await companyAgentProfileCache.invalidate(input.companyId);
    return toRuntimeProfile(saved);
  }

  async upsertDepartmentManagedProfile(
    input: UpsertDepartmentManagedProfileInput,
  ): Promise<CompanyAgentProfileRuntime> {
    const normalizedToolIds = normalizeToolIds(input.toolIds);
    if (normalizedToolIds.length === 0) {
      throw new Error('Department-managed profiles require at least one enabled tool.');
    }

    const currentProfile = input.currentProfileId
      ? await prisma.companyAgentProfile.findFirst({
          where: {
            id: input.currentProfileId,
            companyId: input.companyId,
          },
        })
      : null;

    const canUpdateInPlace = Boolean(
      currentProfile
      && !currentProfile.isSeeded
      && currentProfile.departmentIds.length === 1
      && currentProfile.departmentIds[0] === input.departmentId,
    );

    const profileId = canUpdateInPlace ? currentProfile!.id : undefined;
    const slug = await this.reserveUniqueSlug({
      companyId: input.companyId,
      desiredSlug: canUpdateInPlace
        ? currentProfile!.slug
        : buildDepartmentManagedProfileSlug(input.departmentSlug),
      excludeProfileId: profileId,
    });

    return this.upsertProfile({
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      profileId,
      slug,
      name: canUpdateInPlace
        ? currentProfile!.name
        : `${normalizeText(input.departmentName) || 'Department'} Agent`,
      description: canUpdateInPlace
        ? currentProfile!.description
        : `Default agent for ${normalizeText(input.departmentName) || 'this department'}.`,
      systemPrompt: input.systemPrompt,
      modelKey: input.modelKey,
      toolIds: normalizedToolIds,
      routingHints: canUpdateInPlace ? currentProfile!.routingHints : [],
      departmentIds: [input.departmentId],
      isActive: true,
    });
  }

  async deleteProfile(input: { companyId: string; profileId: string }): Promise<void> {
    await prisma.companyAgentProfile.deleteMany({
      where: { id: input.profileId, companyId: input.companyId },
    });
    await prisma.departmentAgentConfig.updateMany({
      where: { department: { companyId: input.companyId }, defaultAgentProfileId: input.profileId },
      data: { defaultAgentProfileId: null },
    });
    const configs = await prisma.departmentAgentConfig.findMany({
      where: {
        department: { companyId: input.companyId },
        specialistAgentProfileIds: { has: input.profileId },
      },
      select: { id: true, specialistAgentProfileIds: true },
    });
    for (const config of configs) {
      const specialistAgentProfileIds = config.specialistAgentProfileIds.filter((id) => id !== input.profileId);
      await prisma.departmentAgentConfig.update({
        where: { id: config.id },
        data: { specialistAgentProfileIds },
      });
    }
    await companyAgentProfileCache.invalidate(input.companyId);
  }

  async resolveDepartmentAssignments(input: {
    companyId: string;
    departmentId?: string;
    defaultAgentProfileId?: string | null;
    specialistAgentProfileIds?: string[];
    allowedToolIds: string[];
    runExposedToolIds?: string[];
    inferredDomain?: string | null;
    latestUserMessage?: string;
    workspaceAvailable?: boolean;
  }): Promise<{
    eligibleProfiles: CompanyAgentProfileRuntime[];
    preferredProfileIds: string[];
  }> {
    const allProfiles = await this.resolveRuntimeProfiles(input.companyId);
    const allowed = new Set(input.allowedToolIds);
    const runExposed = new Set(input.runExposedToolIds ?? []);
    const useRunScoped = runExposed.size > 0 && runExposed.size < allowed.size;

    const activeDepartmentScoped = allProfiles.filter((profile) =>
      profile.toolIds.some((toolId) => allowed.has(toolId))
      && (
        !input.departmentId
        || profile.departmentIds.length === 0
        || profile.departmentIds.includes(input.departmentId)
      ),
    );

    const attachedIds = uniq([
      input.defaultAgentProfileId ?? undefined,
      ...(input.specialistAgentProfileIds ?? []),
    ]);
    const attachedProfiles = attachedIds.length > 0
      ? activeDepartmentScoped.filter((profile) => attachedIds.includes(profile.id))
      : activeDepartmentScoped;

    const eligibleProfiles = (attachedProfiles.length > 0 ? attachedProfiles : activeDepartmentScoped).filter((profile) =>
      !useRunScoped || profile.toolIds.some((toolId) => runExposed.has(toolId)),
    );
    const finalEligible = eligibleProfiles.length > 0 ? eligibleProfiles : activeDepartmentScoped;

    const preferred = new Set<string>();
    if (input.defaultAgentProfileId && finalEligible.some((profile) => profile.id === input.defaultAgentProfileId)) {
      preferred.add(input.defaultAgentProfileId);
    }
    for (const specialistId of input.specialistAgentProfileIds ?? []) {
      if (finalEligible.some((profile) => profile.id === specialistId)) {
        preferred.add(specialistId);
      }
    }

    const normalizedMessage = (input.latestUserMessage ?? '').toLowerCase();
    if (input.workspaceAvailable) {
      const workspaceProfile = finalEligible.find((profile) =>
        profile.toolIds.some((toolId) => (DOMAIN_TO_TOOL_IDS.workspace ?? []).includes(toolId)),
      );
      if (workspaceProfile) preferred.add(workspaceProfile.id);
    }
    const sendLike = /\b(send|email|mail|reply|forward|invite|calendar|meeting)\b/i.test(normalizedMessage);
    if (sendLike) {
      const sendProfile = finalEligible.find((profile) =>
        profile.toolIds.some((toolId) =>
          toolId === 'googleWorkspace'
          || toolId === 'google-gmail'
          || toolId === 'larkMessage'
          || toolId === 'lark-message-write'
          || toolId === 'google-workspace-agent'),
      );
      if (sendProfile) preferred.add(sendProfile.id);
    }
    if (input.inferredDomain) {
      const domainMatches = DOMAIN_TO_TOOL_IDS[input.inferredDomain as keyof typeof DOMAIN_TO_TOOL_IDS] ?? [];
      for (const profile of finalEligible) {
        if (profile.toolIds.some((toolId) => domainMatches.includes(toolId))) {
          preferred.add(profile.id);
        }
      }
    }
    if (preferred.size === 0 && finalEligible[0]) {
      preferred.add(finalEligible[0].id);
    }

    return {
      eligibleProfiles: finalEligible,
      preferredProfileIds: Array.from(preferred),
    };
  }
}

export const companyAgentProfileService = new CompanyAgentProfileService();

export const resolveCompanyAgentProfileRuntime = toRuntimeProfile;
