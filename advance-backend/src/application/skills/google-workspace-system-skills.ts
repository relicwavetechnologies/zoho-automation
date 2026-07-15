import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  GOOGLE_WORKSPACE_MCP_SOURCE,
  GOOGLE_WORKSPACE_PRODUCTS,
  type GoogleWorkspaceProductDefinition,
} from '../google/google-workspace-mcp-manifest';
import { recordSkillRegistryMutation } from './skill-registry-versioning';

export interface GoogleWorkspaceSystemSkillDefinition {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly markdown: string;
  readonly toolIds: readonly string[];
  readonly tags: readonly string[];
  readonly sortOrder: number;
}

export const GOOGLE_WORKSPACE_SYSTEM_SKILLS: readonly GoogleWorkspaceSystemSkillDefinition[] =
  GOOGLE_WORKSPACE_PRODUCTS.map((product, index) => ({
    slug: `google-${product.service}`,
    name: product.name,
    summary: product.description,
    markdown: buildProductSkillMarkdown(product),
    toolIds: [product.toolId],
    tags: ['google', 'workspace', product.service],
    sortOrder: (index + 1) * 10,
  }));

const GOOGLE_FOLDER = {
  name: 'Google Workspace',
  slug: 'google-workspace',
  departmentId: null,
  parentId: null,
  status: 'active',
  sortOrder: 30,
} as const;

type GoogleSkillStore = Pick<
  Prisma.TransactionClient,
  'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant'
>;

type ExistingSkill = {
  id: string;
  slug: string;
  companyId: string;
  departmentId: string | null;
  folderId: string | null;
  scope: string;
  name: string;
  summary: string;
  markdown: string;
  toolIds: string[];
  tags: string[];
  status: string;
  isSystem: boolean;
  sortOrder: number;
  revision: number;
  createdBy: string | null;
  updatedBy: string | null;
};

const EXISTING_SKILL_SELECT = {
  id: true,
  slug: true,
  companyId: true,
  departmentId: true,
  folderId: true,
  scope: true,
  name: true,
  summary: true,
  markdown: true,
  toolIds: true,
  tags: true,
  status: true,
  isSystem: true,
  sortOrder: true,
  revision: true,
  createdBy: true,
  updatedBy: true,
} as const;

export async function provisionGoogleWorkspaceSystemSkills(
  db: GoogleSkillStore,
  companyId: string,
): Promise<{ folderId: string; created: number; updated: number; existing: number; skipped: number }> {
  const folderId = await ensureFolder(db, companyId);
  let created = 0;
  let updated = 0;
  let existing = 0;
  let skipped = 0;

  for (const definition of GOOGLE_WORKSPACE_SYSTEM_SKILLS) {
    const current = await db.skill.findFirst({
      where: { companyId, slug: definition.slug, status: { not: 'archived' } },
      select: EXISTING_SKILL_SELECT,
    }) as ExistingSkill | null;

    if (current && !current.isSystem) {
      skipped += 1;
      continue;
    }

    let skill: ExistingSkill;
    if (!current) {
      skill = await db.skill.create({
        data: buildGoogleWorkspaceSystemSkill(companyId, folderId, definition),
      }) as ExistingSkill;
      await recordSkillRegistryMutation(db, skill, 'system');
      created += 1;
    } else if (matchesDefinition(current, folderId, definition)) {
      skill = current;
      existing += 1;
    } else {
      skill = await db.skill.update({
        where: { id: current.id },
        data: {
          ...definitionFields(folderId, definition),
          toolIds: [...definition.toolIds],
          tags: [...definition.tags],
          revision: { increment: 1 },
        },
      }) as ExistingSkill;
      await recordSkillRegistryMutation(db, skill, 'system');
      updated += 1;
    }

    await db.skillAccessGrant.upsert({
      where: {
        skillId_granteeType_granteeId: {
          skillId: skill.id,
          granteeType: 'company',
          granteeId: companyId,
        },
      },
      create: {
        companyId,
        skillId: skill.id,
        granteeType: 'company',
        granteeId: companyId,
      },
      update: {},
    });
  }

  return { folderId, created, updated, existing, skipped };
}

export async function provisionGoogleWorkspaceSkillsForExistingCompanies(
  db: Pick<PrismaClient, 'company' | 'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant'>,
): Promise<{ companies: number; created: number; updated: number; existing: number; skipped: number }> {
  const companies = await db.company.findMany({ select: { id: true } });
  const totals = { companies: companies.length, created: 0, updated: 0, existing: 0, skipped: 0 };
  for (const company of companies) {
    const result = await provisionGoogleWorkspaceSystemSkills(db, company.id);
    totals.created += result.created;
    totals.updated += result.updated;
    totals.existing += result.existing;
    totals.skipped += result.skipped;
  }
  return totals;
}

export function buildGoogleWorkspaceSystemSkill(
  companyId: string,
  folderId: string,
  definition: GoogleWorkspaceSystemSkillDefinition,
): Prisma.SkillUncheckedCreateInput & { id: string } {
  return {
    id: deterministicId(companyId, `skill:${definition.slug}`),
    companyId,
    ...definitionFields(folderId, definition),
    toolIds: [...definition.toolIds],
    tags: [...definition.tags],
  };
}

function buildProductSkillMarkdown(product: GoogleWorkspaceProductDefinition): string {
  return `# ${product.name}

Use this skill for ${product.description.toLowerCase()}

## Governed execution

1. List accessible connections with provider \`google_workspace\`.
2. Select the exact backend \`connectionId\`; ask when multiple accounts are plausible.
3. Use only \`${product.toolId}\`. Never use a local Google CLI, Bash, curl, browser automation, or direct Google API calls.
4. Call \`op: "describe"\` with the selected \`nativeTool\` before its first unfamiliar use. Follow the returned MCP input schema exactly.
5. Call \`op: "call"\` with the same \`nativeTool\` and its arguments under \`input\`.
6. Never send \`user_google_email\`; Divo derives it from the selected connection.

## Approved operations

${product.tools.map((tool) => `- \`${tool}\``).join('\n')}

## Reliability and safety

- The operation contract is pinned to Workspace MCP ${GOOGLE_WORKSPACE_MCP_SOURCE.version}. Do not invent operations outside the list above.
- Preserve Divo RBAC, sharing, approval, and audit results. Pending or denied is not completed.
- Never guess Google resource IDs. Discover or read the target before an ambiguous mutation.
- Verify important content changes with a read operation and return canonical Google URLs from successful responses.
- Never expose tokens or the private MCP endpoint. Sidecar-local file paths and file URLs are forbidden; use base64 content or HTTPS sources.`;
}

async function ensureFolder(db: GoogleSkillStore, companyId: string): Promise<string> {
  const existing = await db.skillFolder.findFirst({
    where: {
      companyId,
      departmentId: null,
      parentId: null,
      slug: GOOGLE_FOLDER.slug,
      status: 'active',
    },
    select: { id: true },
  });
  if (existing) return existing.id;

  const id = deterministicId(companyId, 'folder:google-workspace');
  const folder = await db.skillFolder.upsert({
    where: { id },
    create: { id, companyId, ...GOOGLE_FOLDER },
    update: { ...GOOGLE_FOLDER },
    select: { id: true },
  });
  return folder.id;
}

function definitionFields(folderId: string, definition: GoogleWorkspaceSystemSkillDefinition) {
  return {
    departmentId: null,
    folderId,
    scope: 'global',
    name: definition.name,
    slug: definition.slug,
    summary: definition.summary,
    markdown: definition.markdown,
    status: 'active',
    isSystem: true,
    sortOrder: definition.sortOrder,
  } as const;
}

function matchesDefinition(
  current: ExistingSkill,
  folderId: string,
  definition: GoogleWorkspaceSystemSkillDefinition,
): boolean {
  return current.departmentId === null
    && current.folderId === folderId
    && current.scope === 'global'
    && current.slug === definition.slug
    && current.name === definition.name
    && current.summary === definition.summary
    && current.markdown === definition.markdown
    && current.status === 'active'
    && current.isSystem
    && current.sortOrder === definition.sortOrder
    && arraysEqual(current.toolIds, definition.toolIds)
    && arraysEqual(current.tags, definition.tags);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deterministicId(companyId: string, key: string): string {
  const hex = createHash('md5').update(`${companyId}:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
