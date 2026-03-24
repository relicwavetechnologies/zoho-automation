import { prisma } from '../../utils/prisma';
import { HttpException } from '../../core/http-exception';
import type { DepartmentAdminSession } from '../departments/department.service';

export type SkillScope = 'global' | 'department';

export type SkillRecord = {
  id: string;
  companyId: string;
  departmentId?: string;
  departmentName?: string;
  scope: SkillScope;
  name: string;
  slug: string;
  summary: string;
  markdown: string;
  tags: string[];
  status: string;
  isSystem: boolean;
  sortOrder: number;
  source: 'database' | 'legacy';
  createdAt?: string;
  updatedAt?: string;
};

export type SkillSearchResult = {
  id: string;
  slug: string;
  name: string;
  summary: string;
  tags: string[];
  scope: SkillScope;
  departmentName?: string;
  source: 'database' | 'legacy';
};

const SYSTEM_GLOBAL_SKILLS = [
  {
    slug: 'coding-ops',
    name: 'Coding Ops',
    summary: 'Use this skill for multi-step local coding work: inspect, plan, execute approved commands, verify outputs, and summarize exact results.',
    tags: ['coding', 'workspace', 'terminal', 'scripts'],
    markdown: `# Coding Ops

Use this skill for non-trivial local coding tasks.

## When to use
- Writing or editing code in the open workspace
- Running scripts or commands
- Inspecting outputs before continuing
- Iterative tasks that require command approval

## Operating pattern
1. Inspect the workspace or target files first.
2. Plan the smallest next local action.
3. Use approved command/file actions only when needed.
4. Verify outputs after each action.
5. Summarize only confirmed results.

## Rules
- Prefer exact file paths and exact command plans.
- If a command fails, inspect the output before retrying.
- Do not claim files were created or updated unless verified.
- Prefer reusable scripts over one-off shell logic when the task is substantial.
`,
  },
  {
    slug: 'web-search',
    name: 'Web Search',
    summary: 'Use this skill for public web research: search, verify sources, extract exact facts, and cite relevant URLs.',
    tags: ['search', 'research', 'web', 'verification'],
    markdown: `# Web Search

Use this skill for public internet research.

## When to use
- Looking up current public information
- Verifying facts with sources
- Finding product, company, or documentation pages
- Pulling exact URLs for follow-up work

## Operating pattern
1. Search with a precise query.
2. Narrow by domain when useful.
3. Read the most relevant result context.
4. Prefer high-signal primary or official sources.
5. Report the answer with links or citations.

## Rules
- Do not use web search for private company knowledge.
- Verify time-sensitive facts instead of guessing.
- Prefer concise, source-backed findings over broad summaries.
`,
  },
  {
    slug: 'workflows-scheduling-ops',
    name: 'Workflows Scheduling Ops',
    summary: 'Use this skill for reusable workflow authoring and scheduling: clarify intent, decide save vs run-now vs schedule, gather missing timing/destination details, and route to workflow or calendar tools safely.',
    tags: ['workflow', 'scheduling', 'prompt', 'automation', 'calendar', 'lark', 'google'],
    markdown: `# Workflows Scheduling Ops

Use this skill when a request may need reusable workflow creation, saving for later, recurring scheduling, or direct calendar scheduling.

## When to use
- The user wants to make a process reusable
- The user says "save this for later", "turn this into a workflow", or "make this a prompt"
- The user asks to schedule recurring work
- The user asks to run a saved workflow
- The right path between workflow authoring and direct calendar scheduling is unclear

## Operating pattern
1. Decide whether the user wants:
   - immediate one-time execution
   - reusable workflow creation
   - reusable workflow plus schedule
   - direct calendar event scheduling
2. If the request is reusable or recurring, prefer workflow-authoring tools.
3. If the request is a normal meeting/event on a calendar, prefer Google Calendar or Lark Calendar tools.
4. When workflow details are missing, ask only for the exact next missing field.
5. Before saving or enabling a schedule, get explicit confirmation.

## Ask for these details when missing
- workflow/prompt objective
- whether they want save only or save plus schedule
- schedule timing
- output destination when it cannot be inferred safely
- calendar provider when the request is a direct event, not a reusable workflow

## Routing rules
- Reusable prompt/process: use workflowDraft, workflowPlan, workflowBuild, workflowSave, workflowSchedule
- List saved prompts/workflows: use workflowList
- Run saved workflow: use workflowRun
- Direct calendar event: use googleCalendar or larkCalendar

## Rules
- Do not guess schedule time if the user has not provided it.
- Do not silently enable scheduling just because a workflow was saved.
- Do not ask generic calendar questions first if the user may actually want a reusable workflow.
- If you feel lost between workflow authoring and domain execution, search and read this skill first.
`,
  },
] as const;

const normalizeSearchValue = (value: string | null | undefined): string =>
  (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const summarizeMarkdown = (markdown: string): string => {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && !line.startsWith('#') && !/^tags?\s*:/i.test(line));
  const summary = lines[0] ?? 'No summary available.';
  return summary.length > 220 ? `${summary.slice(0, 220)}...` : summary;
};

const parseLegacyTags = (markdown: string): string[] => {
  const line = markdown.split('\n').find((entry) => /^tags?\s*:/i.test(entry.trim()));
  if (!line) return [];
  return line
    .replace(/^tags?\s*:/i, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 12);
};

const splitLegacySections = (
  markdown: string,
  input: { companyId: string; departmentId?: string; departmentName?: string },
): SkillRecord[] => {
  const normalized = markdown.trim();
  if (!normalized) return [];

  const matches = Array.from(normalized.matchAll(/^##+\s+(.+)$/gm));
  if (matches.length === 0) {
    return [{
      id: 'legacy:department-skills',
      companyId: input.companyId,
      departmentId: input.departmentId,
      departmentName: input.departmentName,
      scope: 'department',
      name: 'Legacy Department Skills',
      slug: 'legacy-department-skills',
      summary: summarizeMarkdown(normalized),
      markdown: normalized,
      tags: parseLegacyTags(normalized),
      status: 'active',
      isSystem: false,
      sortOrder: 999,
      source: 'legacy',
    }];
  }

  return matches.map((match, index) => {
    const heading = match[1]?.trim() || `Legacy Skill ${index + 1}`;
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? normalized.length;
    const sectionMarkdown = normalized.slice(start, end).trim();
    return {
      id: `legacy:${slugify(heading) || `skill-${index + 1}`}`,
      companyId: input.companyId,
      departmentId: input.departmentId,
      departmentName: input.departmentName,
      scope: 'department' as const,
      name: heading,
      slug: slugify(heading) || `legacy-skill-${index + 1}`,
      summary: summarizeMarkdown(sectionMarkdown),
      markdown: sectionMarkdown,
      tags: parseLegacyTags(sectionMarkdown),
      status: 'active',
      isSystem: false,
      sortOrder: 999 + index,
      source: 'legacy' as const,
    };
  });
};

const scoreSkill = (skill: SkillRecord, query: string): number => {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return 0;

  const fields = [skill.name, skill.summary, ...skill.tags, skill.markdown]
    .map((value) => normalizeSearchValue(value))
    .filter(Boolean);

  let bestScore = -1;
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);

  for (const field of fields) {
    if (field === normalizedQuery) bestScore = Math.max(bestScore, 120);
    if (field.startsWith(normalizedQuery)) bestScore = Math.max(bestScore, 90);
    if (field.includes(normalizedQuery)) bestScore = Math.max(bestScore, 70);
    if (terms.length > 1 && terms.every((term) => field.includes(term))) {
      bestScore = Math.max(bestScore, 80);
    }
    if (field.replace(/\s+/g, '').includes(compactQuery)) {
      bestScore = Math.max(bestScore, 75);
    }
  }

  if (bestScore < 0) return -1;
  return bestScore + (skill.scope === 'department' ? 5 : 0) + (skill.source === 'database' ? 3 : 0);
};

const toSkillRecord = (row: {
  id: string;
  companyId: string;
  departmentId: string | null;
  scope: string;
  name: string;
  slug: string;
  summary: string;
  markdown: string;
  tags: string[];
  status: string;
  isSystem: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  department?: { name: string } | null;
}): SkillRecord => ({
  id: row.id,
  companyId: row.companyId,
  departmentId: row.departmentId ?? undefined,
  departmentName: row.department?.name ?? undefined,
  scope: row.scope as SkillScope,
  name: row.name,
  slug: row.slug,
  summary: row.summary,
  markdown: row.markdown,
  tags: row.tags,
  status: row.status,
  isSystem: row.isSystem,
  sortOrder: row.sortOrder,
  source: 'database',
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toSkillSearchResult = (skill: SkillRecord): SkillSearchResult => ({
  id: skill.id,
  slug: skill.slug,
  name: skill.name,
  summary: skill.summary,
  tags: [...skill.tags],
  scope: skill.scope,
  departmentName: skill.departmentName,
  source: skill.source,
});

class SkillService {
  private async assertDepartmentAccess(session: DepartmentAdminSession, departmentId: string) {
    const department = await prisma.department.findUnique({
      where: { id: departmentId },
      include: { agentConfig: true },
    });
    if (!department) {
      throw new HttpException(404, 'Department not found.');
    }
    if (session.role !== 'SUPER_ADMIN' && department.companyId !== session.companyId) {
      throw new HttpException(403, 'Company scope mismatch.');
    }
    if (session.role === 'DEPARTMENT_MANAGER') {
      const managerMembership = await prisma.departmentMembership.findFirst({
        where: {
          departmentId,
          userId: session.userId,
          status: 'active',
          role: { slug: 'MANAGER' },
        },
      });
      if (!managerMembership) {
        throw new HttpException(403, 'Manager access denied for this department.');
      }
    }
    return department;
  }

  async ensureSystemGlobalSkills(companyId: string): Promise<void> {
    await Promise.all(
      SYSTEM_GLOBAL_SKILLS.map(async (skill, index) => {
        const existing = await prisma.skill.findFirst({
          where: {
            companyId,
            scope: 'global',
            slug: skill.slug,
          },
        });

        if (existing) {
          await prisma.skill.update({
            where: { id: existing.id },
            data: {
              name: skill.name,
              summary: skill.summary,
              markdown: skill.markdown,
              tags: [...skill.tags],
              isSystem: true,
              status: 'active',
              sortOrder: index,
            },
          });
          return;
        }

        await prisma.skill.create({
          data: {
            companyId,
            scope: 'global',
            name: skill.name,
            slug: skill.slug,
            summary: skill.summary,
            markdown: skill.markdown,
            tags: [...skill.tags],
            status: 'active',
            isSystem: true,
            sortOrder: index,
          },
        });
      }),
    );
  }

  async listAdminSkillBundle(session: DepartmentAdminSession, departmentId: string): Promise<{
    globalSkills: SkillRecord[];
    departmentSkills: SkillRecord[];
  }> {
    const department = await this.assertDepartmentAccess(session, departmentId);
    await this.ensureSystemGlobalSkills(department.companyId);

    const [globalRows, departmentRows] = await Promise.all([
      prisma.skill.findMany({
        where: {
          companyId: department.companyId,
          scope: 'global',
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      prisma.skill.findMany({
        where: {
          companyId: department.companyId,
          departmentId: department.id,
          scope: 'department',
        },
        include: {
          department: { select: { name: true } },
        },
        orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);

    return {
      globalSkills: globalRows.map(toSkillRecord),
      departmentSkills: departmentRows.map(toSkillRecord),
    };
  }

  async createDepartmentSkill(
    session: DepartmentAdminSession,
    departmentId: string,
    input: { name: string; slug?: string; summary?: string; markdown: string; tags?: string[]; status?: string },
  ): Promise<SkillRecord> {
    const department = await this.assertDepartmentAccess(session, departmentId);
    const name = input.name.trim();
    const slug = slugify(input.slug?.trim() || name);
    if (!name || !slug) {
      throw new HttpException(400, 'Skill name and slug are required.');
    }

    const existing = await prisma.skill.findFirst({
      where: {
        companyId: department.companyId,
        scope: 'department',
        departmentId,
        slug,
      },
    });
    if (existing) {
      throw new HttpException(409, 'A department skill with this slug already exists.');
    }

    const nextSortOrder = await prisma.skill.count({
      where: {
        companyId: department.companyId,
        departmentId,
        scope: 'department',
      },
    });

    const created = await prisma.skill.create({
      data: {
        companyId: department.companyId,
        departmentId,
        scope: 'department',
        name,
        slug,
        summary: input.summary?.trim() || summarizeMarkdown(input.markdown),
        markdown: input.markdown.trim(),
        tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
        status: input.status === 'archived' ? 'archived' : 'active',
        sortOrder: nextSortOrder,
        createdBy: session.userId,
        updatedBy: session.userId,
      },
      include: {
        department: { select: { name: true } },
      },
    });

    return toSkillRecord(created);
  }

  async updateDepartmentSkill(
    session: DepartmentAdminSession,
    departmentId: string,
    skillId: string,
    input: { name: string; slug?: string; summary?: string; markdown: string; tags?: string[]; status?: string },
  ): Promise<SkillRecord> {
    const department = await this.assertDepartmentAccess(session, departmentId);
    const existing = await prisma.skill.findFirst({
      where: {
        id: skillId,
        companyId: department.companyId,
        departmentId,
        scope: 'department',
      },
      include: {
        department: { select: { name: true } },
      },
    });
    if (!existing) {
      throw new HttpException(404, 'Department skill not found.');
    }

    const name = input.name.trim();
    const slug = slugify(input.slug?.trim() || name);
    if (!name || !slug) {
      throw new HttpException(400, 'Skill name and slug are required.');
    }

    const duplicate = await prisma.skill.findFirst({
      where: {
        companyId: department.companyId,
        scope: 'department',
        departmentId,
        slug,
        id: { not: skillId },
      },
    });
    if (duplicate) {
      throw new HttpException(409, 'A department skill with this slug already exists.');
    }

    const updated = await prisma.skill.update({
      where: { id: skillId },
      data: {
        name,
        slug,
        summary: input.summary?.trim() || summarizeMarkdown(input.markdown),
        markdown: input.markdown.trim(),
        tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
        status: input.status === 'archived' ? 'archived' : 'active',
        updatedBy: session.userId,
      },
      include: {
        department: { select: { name: true } },
      },
    });

    return toSkillRecord(updated);
  }

  async archiveDepartmentSkill(
    session: DepartmentAdminSession,
    departmentId: string,
    skillId: string,
  ): Promise<{ id: string; status: string }> {
    const department = await this.assertDepartmentAccess(session, departmentId);
    const existing = await prisma.skill.findFirst({
      where: {
        id: skillId,
        companyId: department.companyId,
        departmentId,
        scope: 'department',
      },
    });
    if (!existing) {
      throw new HttpException(404, 'Department skill not found.');
    }
    const updated = await prisma.skill.update({
      where: { id: skillId },
      data: {
        status: 'archived',
        updatedBy: session.userId,
      },
    });
    return { id: updated.id, status: updated.status };
  }

  private async buildLegacyFallbackSkills(input: {
    companyId: string;
    departmentId?: string;
  }): Promise<SkillRecord[]> {
    if (!input.departmentId) return [];
    const department = await prisma.department.findFirst({
      where: {
        id: input.departmentId,
        companyId: input.companyId,
      },
      include: { agentConfig: true },
    });
    if (!department?.agentConfig?.skillsMarkdown?.trim()) return [];
    const structuredCount = await prisma.skill.count({
      where: {
        companyId: input.companyId,
        departmentId: input.departmentId,
        scope: 'department',
        status: 'active',
      },
    });
    if (structuredCount > 0) return [];
    return splitLegacySections(department.agentConfig.skillsMarkdown, {
      companyId: input.companyId,
      departmentId: input.departmentId,
      departmentName: department.name,
    });
  }

  async listVisibleSkills(input: {
    companyId: string;
    departmentId?: string;
  }): Promise<SkillRecord[]> {
    await this.ensureSystemGlobalSkills(input.companyId);
    const rows = await prisma.skill.findMany({
      where: {
        companyId: input.companyId,
        status: 'active',
        OR: [
          { scope: 'global' },
          ...(input.departmentId ? [{ scope: 'department', departmentId: input.departmentId }] : []),
        ],
      },
      include: {
        department: { select: { name: true } },
      },
      orderBy: [{ scope: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    const fallback = await this.buildLegacyFallbackSkills(input);
    return [...rows.map(toSkillRecord), ...fallback];
  }

  async searchVisibleSkills(input: {
    companyId: string;
    departmentId?: string;
    query: string;
    limit?: number;
  }): Promise<SkillSearchResult[]> {
    const skills = await this.listVisibleSkills(input);
    return skills
      .map((skill) => ({ skill, score: scoreSkill(skill, input.query) }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.skill.name.localeCompare(right.skill.name);
      })
      .slice(0, Math.max(1, Math.min(input.limit ?? 5, 10)))
      .map((entry) => toSkillSearchResult(entry.skill));
  }

  async readVisibleSkill(input: {
    companyId: string;
    departmentId?: string;
    skillId?: string;
    skillSlug?: string;
  }): Promise<SkillRecord | null> {
    const skills = await this.listVisibleSkills({
      companyId: input.companyId,
      departmentId: input.departmentId,
    });
    return skills.find((skill) => {
      if (input.skillId && skill.id === input.skillId) return true;
      if (input.skillSlug && skill.slug === input.skillSlug) return true;
      return false;
    }) ?? null;
  }
}

export const skillService = new SkillService();
